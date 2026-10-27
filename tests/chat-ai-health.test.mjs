import test from "node:test";
import assert from "node:assert/strict";
import {GameHubDispatcher, IdentityVault} from "../packages/core/src/index.mjs";
import {createModule} from "../packages/plugin/chat-ai/src/index.mjs";

let sequence = 0;
const event = (text, overrides = {}) => ({
  eventId: "ev-" + (++sequence),
  messageId: "msg-" + sequence,
  platform: "mock",
  botId: "999",
  unifiedUserId: "mock:admin",
  cleanText: text,
  sender: {id: "admin", name: "管理员"},
  reply: async () => ({success: true}),
  ...overrides
});

const withEnv = (name, value) => {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
};

test("启动健康检查：各种 HTTP 响应与网络异常判定可用性", async t => {
  const restoreEnv1 = withEnv("CHATAI_KEY_OK", "sk-ok-123");
  const restoreEnv2 = withEnv("CHATAI_KEY_BAD", "sk-bad-456");
  const restoreEnv3 = withEnv("CHATAI_KEY_TIMEOUT", "sk-timeout-789");
  t.after(() => {
    restoreEnv1();
    restoreEnv2();
    restoreEnv3();
  });

  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());

  // 模拟 fetch 针对不同 URL 返回不同响应
  const fetchImpl = async (url, init) => {
    if (url.includes("/ok/")) {
      return {ok: true, status: 200, json: async () => ({data: []})};
    }
    if (url.includes("/bad/")) {
      return {ok: false, status: 401, json: async () => ({error: "unauthorized"})};
    }
    if (url.includes("/timeout/")) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    if (url.includes("/500/")) {
      return {ok: false, status: 500, json: async () => ({data:[]})};
    }
    throw new Error("connection refused");
  };

  const dispatcher = new GameHubDispatcher({vault, adminToken: "hub-secret"});
  const module = createModule({config: {debug: true}, vault, dispatcher, fetchImpl});
  dispatcher.registerPlugin(module);
  const store = module.services.store;

  // 1. 档案 m_ok: 探测成功 200 -> 可用
  store.saveModel({id: "m_ok", endpoint: "https://api.example.com/ok/v1", model: "m1", apiKeyEnv: "CHATAI_KEY_OK"});
  // 2. 档案 m_bad: 401 -> 密钥无效（不可用）
  store.saveModel({id: "m_bad", endpoint: "https://api.example.com/bad/v1", model: "m2", apiKeyEnv: "CHATAI_KEY_BAD"});
  // 3. 档案 m_timeout: 超时 -> 未确认（仍算可用）
  store.saveModel({id: "m_timeout", endpoint: "https://api.example.com/timeout/v1", model: "m3", apiKeyEnv: "CHATAI_KEY_TIMEOUT"});
  // 4. 档案 m_nokey: 环境变量未配置 -> 密钥无效（不可用）
  store.saveModel({id: "m_nokey", endpoint: "https://api.example.com/nokey/v1", model: "m4", apiKeyEnv: "CHATAI_KEY_MISSING_ENV"});

  // 执行 start() 触发启动健康检查
  await module.start();

  const health = module.services.health;
  assert.ok(health.checkedAt > 0);
  const byId = new Map(health.profiles.map(p => [p.id, p]));

  assert.equal(byId.get("m_ok").status, "可用");
  assert.equal(byId.get("m_ok").usable, true);

  assert.equal(byId.get("m_bad").status, "密钥无效");
  assert.equal(byId.get("m_bad").usable, false);

  assert.equal(byId.get("m_timeout").status, "未确认");
  assert.equal(byId.get("m_timeout").usable, true);

  assert.equal(byId.get("m_nokey").status, "密钥无效");
  assert.equal(byId.get("m_nokey").usable, false);

  await module.stop();
});

test("默认模型固定：优先配置的可用档案，否则按 created_at ASC 取第一个可用，无可用记 ERROR，运行期不自动重算", async t => {
  const restoreEnvA = withEnv("CHATAI_KEY_A", "sk-a");
  const restoreEnvB = withEnv("CHATAI_KEY_B", "sk-b");
  t.after(() => {
    restoreEnvA();
    restoreEnvB();
  });

  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());

  const fetchImpl = async () => ({ok: true, status: 200, json: async () => ({data:[]})});
  const dispatcher = new GameHubDispatcher({vault, adminToken: "hub-secret"});
  dispatcher.addAdmin("mock:admin");

  let nowMs = 1000;
  const now = () => nowMs;

  const module = createModule({
    config: {
      model: {defaultProfileId: "not_usable_or_absent"}
    },
    vault,
    dispatcher,
    now,
    fetchImpl
  });
  dispatcher.registerPlugin(module);
  const store = module.services.store;

  // 先存 model_early
  nowMs = 1000;
  store.saveModel({id: "model_early", endpoint: "https://api.example.com/v1", model: "m-early", apiKeyEnv: "CHATAI_KEY_A"});
  // 后存 model_later
  nowMs = 2000;
  store.saveModel({id: "model_later", endpoint: "https://api.example.com/v1", model: "m-later", apiKeyEnv: "CHATAI_KEY_B"});

  // 启动检查
  await module.start();

  // 因为 configuredDefault "not_usable_or_absent" 不存在，回退到按 created_at 取第一个可用的 model_early
  assert.equal(module.services.health.defaultProfileId, "model_early");

  // 运行期新增更靠前或更高优先级的模型，health.defaultProfileId 保持不变（不自动重算）
  store.saveModel({id: "model_new_runtime", endpoint: "https://api.example.com/v1", model: "m-new", apiKeyEnv: "CHATAI_KEY_A"});
  assert.equal(module.services.health.defaultProfileId, "model_early");

  // 验证 !状态 输出中包含默认模型与健康检查提示
  const replies = [];
  await dispatcher.dispatch(event("!状态", {
    reply: async msg => { replies.push(String(msg)); return {success: true}; }
  }));
  const statusReply = replies.join("\n");
  assert.match(statusReply, /默认档案: model_early/);
  assert.match(statusReply, /管理员切换立即生效/);
  assert.match(statusReply, /model_early: 可用/);

  await module.stop();
});

test("全部模型均不可用时：默认档案为空，所有会话消息收到联系管理员提示", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());

  // 模拟所有请求返回 401
  const fetchImpl = async () => ({ok: false, status: 401, json: async () => ({data:[]})});
  const restoreKey = withEnv("CHATAI_KEY_FAIL", "sk-fail");
  t.after(restoreKey);

  const dispatcher = new GameHubDispatcher({vault, adminToken: "hub-secret"});
  const module = createModule({config: {}, vault, dispatcher, fetchImpl});
  dispatcher.registerPlugin(module);
  const store = module.services.store;

  store.saveModel({id: "broken", endpoint: "https://api.example.com/v1", model: "mbad", apiKeyEnv: "CHATAI_KEY_FAIL"});

  await module.start();
  assert.equal(module.services.health.defaultProfileId, "");

  // 普通私聊消息触发 fallback 回复 -> 收到友好提示而非静默
  const replies = [];
  const out = await dispatcher.dispatch(event("你好助手", {
    reply: async msg => { replies.push(String(msg)); return {success: true}; }
  }));
  assert.equal(out.status, "HANDLED");
  assert.match(replies.join("\n"), /聊天 AI 尚未配置可用模型（缺少密钥或模型档案），请联系管理员。/);

  await module.stop();
});

test("!模型检测 [别名]：现场探测指定或全部档案", async t => {
  const restoreKey = withEnv("CHATAI_KEY_TEST", "sk-test");
  t.after(restoreKey);

  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());

  const fetchImpl = async url => {
    if (url.includes("/online/")) return {ok: true, status: 200, json: async () => ({data:[]})};
    return {ok: false, status: 403, json: async () => ({data:[]})};
  };

  const dispatcher = new GameHubDispatcher({vault, adminToken: "hub-secret"});
  dispatcher.addAdmin("mock:admin");
  const module = createModule({config: {}, vault, dispatcher, fetchImpl});
  dispatcher.registerPlugin(module);
  const store = module.services.store;

  store.saveModel({id: "online", endpoint: "https://api.example.com/online/v1", model: "m-online", apiKeyEnv: "CHATAI_KEY_TEST"});
  store.saveModel({id: "forbidden", endpoint: "https://api.example.com/forbidden/v1", model: "m-403", apiKeyEnv: "CHATAI_KEY_TEST"});

  const replies = [];
  const dispatch = async text => {
    const before = replies.length;
    const output = await dispatcher.dispatch(event(text, {
      reply: async msg => { replies.push(String(msg)); return {success: true}; }
    }));
    return {status: output.status, reply: replies.slice(before).join("\n")};
  };

  // 检测全部
  let out = await dispatch("!模型检测");
  assert.equal(out.status, "HANDLED");
  assert.match(out.reply, /【模型检测结果】/);
  assert.match(out.reply, /online: 可用/);
  assert.match(out.reply, /forbidden: 密钥无效/);

  // 检测指定单个
  out = await dispatch("!模型检测 online");
  assert.match(out.reply, /online: 可用/);
  assert.doesNotMatch(out.reply, /forbidden/);

  // 检测不存在的
  out = await dispatch("!模型检测 non_exist");
  assert.match(out.reply, /未找到模型档案 non_exist/);

  await module.stop();
});
