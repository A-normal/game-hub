import test from "node:test";
import assert from "node:assert/strict";
import {GameHubDispatcher, IdentityVault} from "../packages/core/src/index.mjs";
import {createModule} from "../packages/plugin/chat-ai/src/index.mjs";
import {dayKey} from "../packages/plugin/chat-ai/src/session.mjs";

const PRIVATE = "mock:999:private:mock:1";
const GROUP = "mock:999:group:555";

let sequence = 0;
const event = (text, overrides = {}) => ({
  eventId: "ev-" + (++sequence), messageId: "msg-" + sequence, platform: "mock", botId: "999",
  unifiedUserId: "mock:1", cleanText: text, sender: {id: "1", name: "小明"},
  reply: async () => ({success: true}), ...overrides
});

const tick = () => new Promise(resolve => setImmediate(resolve));

/** 立即返回的假 client；calls 记录 messages 与 signal。 */
const instantClient = (text = "好的", usage = {input: 3, output: 5}) => {
  const calls = [];
  return {
    calls,
    async complete(input) {
      calls.push(input);
      return {text, usage, model: "test-model"};
    }
  };
};

/** 手动放行的假 client：用于并发、epoch、abort 断言。 */
const manualClient = () => {
  const calls = [];
  let inflight = 0;
  let maxInflight = 0;
  return {
    calls,
    get inflight() { return inflight; },
    get maxInflight() { return maxInflight; },
    complete(input) {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      const entry = {input, seq: calls.length + 1, settled: false};
      entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      entry.promise.then(() => { inflight -= 1; }, () => { inflight -= 1; });
      input.signal?.addEventListener("abort", () => {
        if (entry.settled) return;
        entry.settled = true;
        const error = new Error("aborted");
        error.name = "AbortError";
        entry.reject(error);
      }, {once: true});
      calls.push(entry);
      return entry.promise;
    },
    settle(entry, text = "回" + entry.seq) {
      if (entry.settled) return;
      entry.settled = true;
      entry.resolve({text, usage: {input: 1, output: 1}, model: "test-model"});
    }
  };
};

const drainReleasing = async (engine, client) => {
  const drained = engine.drain();
  let done = false;
  drained.then(() => { done = true; });
  for (let guard = 0; guard < 2000 && !done; guard += 1) {
    for (const call of client.calls) client.settle(call);
    await tick();
  }
  await drained;
  assert.equal(done, true);
};

const setup = ({config = {}, client, now = Date.now, admin = false, model = "main"} = {}) => {
  const vault = new IdentityVault(":memory:");
  const dispatcher = new GameHubDispatcher({vault, adminToken: "secret"});
  dispatcher.registerProvider({id: "llm", kind: "provider", contractVersion: 1, capabilities: ["chat"], createClient: () => client});
  const merged = model ? {...config, model: {defaultProfileId: model, ...(config.model || {})}} : config;
  const module = createModule({config: merged, vault, dispatcher, now});
  const store = module.services.store;
  if (model) store.saveModel({id: model, endpoint: "https://api.example.com/v1/chat/completions", model: "test-model", apiKeyEnv: "CHATAI_KEY_TEST"});
  dispatcher.registerPlugin(module);
  if (admin) dispatcher.addAdmin("mock:1");
  const replies = [];
  const dispatch = async (text, overrides = {}) => {
    const before = replies.length;
    const output = await dispatcher.dispatch(event(text, {
      reply: async message => { replies.push(String(message)); return {success: true}; },
      ...overrides
    }));
    return {status: output.status, replies: replies.slice(before), reply: replies.slice(before).join("\n")};
  };
  return {vault, dispatcher, module, engine: module.services.engine, store, replies, dispatch};
};

test("私聊 all：模型调用 1 次、清洗后发送、assistant 入库、额度 +1", async t => {
  const time = new Date(2026, 9, 26, 12, 0).getTime();
  const client = instantClient("  好耶 [CQ:at,qq=all] 欢迎  ");
  const h = setup({client, now: () => time});
  t.after(() => h.vault.close());

  const out = await h.dispatch("你好", {eventId: "r-1"});
  assert.equal(out.status, "HANDLED");
  await h.engine.drain();

  assert.equal(client.calls.length, 1);
  const messages = client.calls[0].messages;
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /纯文本/);
  assert.deepEqual(messages.filter(message => message.role === "user"), [{role: "user", content: "你好"}]);
  assert.ok(client.calls[0].signal instanceof AbortSignal);

  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0].includes("[CQ:"), false);
  assert.ok(h.replies[0].includes("好耶"));
  assert.ok(h.replies[0].includes("欢迎"));

  const rows = h.store.recentMessages(PRIVATE, 10);
  assert.deepEqual(rows.map(row => row.role), ["user", "assistant"]);
  assert.equal(rows[1].text, h.replies[0]);

  const usage = h.store.getUsage(PRIVATE, dayKey(time));
  assert.equal(usage.requests, 1);
  assert.equal(usage.tokensIn, 3);
  assert.equal(usage.tokensOut, 5);
});

test("群聊 mention：未 @ 不调用模型也不回复；@ 后调用一次且带发送者前缀", async t => {
  const client = instantClient("在的");
  const h = setup({client});
  t.after(() => h.vault.close());
  const group = {isGroup: true, groupId: "555", unifiedUserId: "mock:2", sender: {id: "2", name: "群友"}};

  let out = await h.dispatch("大家好", {eventId: "m-1", ...group});
  assert.equal(out.status, "NOT_MATCHED");
  assert.equal(client.calls.length, 0);
  assert.deepEqual(h.replies, []);
  // mention 只限制回复，不限制记录
  assert.equal(h.store.countMessages(GROUP), 1);

  out = await h.dispatch("大家好呀", {eventId: "m-2", mentionedBot: true, ...group});
  assert.equal(out.status, "HANDLED");
  await h.engine.drain();
  assert.equal(client.calls.length, 1);
  assert.equal(h.replies.length, 1);
  const users = client.calls[0].messages.filter(message => message.role === "user").map(message => message.content);
  assert.deepEqual(users, ["[群友] 大家好", "[群友] 大家好呀"]);
});

test("群聊 all：未 @ 也回复；策略 off：既不记录也不回复", async t => {
  const client = instantClient("收到");
  const h = setup({client, config: {policy: {groupDefault: "all"}}});
  t.after(() => h.vault.close());
  const group = {isGroup: true, groupId: "555", unifiedUserId: "mock:2", sender: {id: "2", name: "群友"}};

  let out = await h.dispatch("群聊普通消息", {eventId: "a-1", ...group});
  assert.equal(out.status, "HANDLED");
  await h.engine.drain();
  assert.equal(client.calls.length, 1);
  assert.equal(h.replies.length, 1);
  const rows = h.store.recentMessages(GROUP, 10);
  assert.deepEqual(rows.map(row => row.role), ["user", "assistant"]);

  h.store.setPolicy(GROUP, "off");
  const frozen = h.store.countMessages(GROUP);
  out = await h.dispatch("off 之后的消息", {eventId: "a-2", ...group});
  assert.equal(out.status, "NOT_MATCHED");
  await h.engine.drain();
  assert.equal(h.store.countMessages(GROUP), frozen);
  assert.equal(client.calls.length, 1);
  assert.equal(h.replies.length, 1);
});

test("无模型档案：报错提示（HANDLED、5 分钟冷却），warn 每次记录", async t => {
  const originalWarn = console.warn;
  const captured = [];
  console.warn = message => captured.push(String(message));
  t.after(() => { console.warn = originalWarn; });

  const client = instantClient("不应调用");
  const h = setup({client, model: null, config: {debug: true}});
  t.after(() => h.vault.close());

  const first = await h.dispatch("第一句", {eventId: "n-1"});
  assert.equal(first.status, "HANDLED");
  await h.engine.drain();
  assert.equal(h.replies.length, 1);
  assert.match(h.replies[0], /聊天 AI 尚未配置可用模型（缺少密钥或模型档案），请联系管理员。/);

  // 冷却内第二句不再重复提示
  const second = await h.dispatch("第二句", {eventId: "n-2"});
  assert.equal(second.status, "HANDLED");
  await h.engine.drain();
  assert.equal(h.replies.length, 1);
  assert.equal(client.calls.length, 0);

  const warnings = captured.filter(line => line.includes("没有可用的模型档案"));
  assert.equal(warnings.length, 2);
});

test("模型失败：发提示（60 秒冷却），LLM_CONFIG 提示尚未配置可用模型（5 分钟冷却）", async t => {
  let time = 1_000_000;
  const failing = {
    calls: 0,
    async complete() {
      this.calls += 1;
      throw Object.assign(new Error("timeout"), {code: "LLM_TIMEOUT"});
    }
  };
  const h = setup({client: failing, now: () => time});
  t.after(() => h.vault.close());

  await h.dispatch("第一句", {eventId: "f-1"});
  await h.engine.drain();
  assert.equal(failing.calls, 1);
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0], "AI 暂时不可用，请稍后再试。");

  time += 1000;
  await h.dispatch("第二句", {eventId: "f-2"});
  await h.engine.drain();
  assert.equal(failing.calls, 2);
  assert.equal(h.replies.length, 1);

  time += 61000;
  await h.dispatch("第三句", {eventId: "f-3"});
  await h.engine.drain();
  assert.equal(failing.calls, 3);
  assert.equal(h.replies.length, 2);

  const misconfigured = {
    calls: 0,
    async complete() {
      this.calls += 1;
      throw Object.assign(new Error("模型密钥未配置"), {code: "LLM_CONFIG"});
    }
  };
  const quiet = setup({client: misconfigured, now: () => 2_000_000});
  t.after(() => quiet.vault.close());
  await quiet.dispatch("你好", {eventId: "f-4"});
  await quiet.engine.drain();
  assert.equal(misconfigured.calls, 1);
  assert.equal(quiet.replies.length, 1);
  assert.match(quiet.replies[0], /聊天 AI 尚未配置可用模型（缺少密钥或模型档案），请联系管理员。/);
});

test("输出清洗与截断：CQ 段剥离、maxCharsOut 生效", async t => {
  const client = instantClient("好耶 [CQ:at,qq=all] 欢迎");
  const h = setup({client, config: {limits: {maxCharsOut: 50}}});
  t.after(() => h.vault.close());
  await h.dispatch("你好", {eventId: "c-1"});
  await h.engine.drain();
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0].includes("[CQ:"), false);
  assert.ok(h.replies[0].includes("好耶"));
  assert.ok(h.replies[0].includes("欢迎"));

  const longClient = instantClient("字".repeat(2000));
  const long = setup({client: longClient, config: {limits: {maxCharsOut: 50}}});
  t.after(() => long.vault.close());
  await long.dispatch("你好", {eventId: "c-2"});
  await long.engine.drain();
  assert.equal(Array.from(long.replies[0]).length, 50);
  assert.equal(long.store.recentMessages(PRIVATE, 10).at(-1).text.length, 50);
});

test("同会话串行与队列上限：3 条全部完成、第 5 条被丢弃", async t => {
  // 场景一：3 条连续消息全部接受并完成
  const immediate = instantClient("回");
  const a = setup({client: immediate, config: {limits: {queuePerSession: 3}}});
  t.after(() => a.vault.close());
  for (let index = 1; index <= 3; index += 1) {
    const out = await a.dispatch("消息" + index, {eventId: "q-a-" + index});
    assert.equal(out.status, "HANDLED", String(index));
  }
  await a.engine.drain();
  assert.equal(a.store.recentMessages(PRIVATE, 10).filter(row => row.role === "assistant").length, 3);
  assert.equal(a.replies.length, 3);

  // 场景二：模型阻塞时 5 条连发 → 1 条执行 + 3 条排队，第 5 条丢弃
  const manual = manualClient();
  const b = setup({client: manual, config: {limits: {queuePerSession: 3}}});
  t.after(() => b.vault.close());
  const statuses = [];
  for (let index = 1; index <= 5; index += 1) {
    statuses.push((await b.dispatch("串行" + index, {eventId: "q-b-" + index})).status);
  }
  assert.deepEqual(statuses, ["HANDLED", "HANDLED", "HANDLED", "HANDLED", "NOT_MATCHED"]);
  assert.equal(manual.calls.length, 1);
  assert.equal(b.engine.pending(PRIVATE), 3);

  await drainReleasing(b.engine, manual);
  assert.equal(manual.maxInflight, 1);
  assert.equal(b.store.recentMessages(PRIVATE, 20).filter(row => row.role === "assistant").length, 4);
  assert.equal(b.replies.length, 4);
});

test("旧任务失效：epoch 变化后不发送、不写 assistant 行", async t => {
  const manual = manualClient();
  const h = setup({client: manual});
  t.after(() => h.vault.close());
  await h.dispatch("你好", {eventId: "e-1"});
  assert.equal(manual.calls.length, 1);

  h.store.bumpEpoch(PRIVATE);
  manual.settle(manual.calls[0], "旧回复");
  await h.engine.drain();

  assert.deepEqual(h.replies, []);
  assert.equal(h.store.recentMessages(PRIVATE, 10).filter(row => row.role === "assistant").length, 0);
  const usage = h.store.getUsage(PRIVATE, dayKey(Date.now()));
  assert.equal(usage.requests, 1); // 已发出的模型调用必须计数，即使结果因 epoch 被丢弃。
});

test("stop()：abort 在途请求、drain 正常结束、之后不再发送", async t => {
  const manual = manualClient();
  const h = setup({client: manual});
  t.after(() => h.vault.close());
  await h.dispatch("你好", {eventId: "s-1"});
  assert.equal(manual.calls.length, 1);
  assert.equal(manual.calls[0].input.signal.aborted, false);

  const stopping = h.engine.stop();
  await stopping;
  assert.equal(manual.calls[0].input.signal.aborted, true);
  assert.deepEqual(h.replies, []);

  const out = await h.dispatch("停止后的消息", {eventId: "s-2"});
  assert.equal(out.status, "NOT_MATCHED");
  assert.equal(manual.calls.length, 1);
});

test("say 与 policySet：显式对话、敏感拒绝、额度、私聊/群聊权限与 off 语义", async t => {
  const client = instantClient("收到你的消息");
  const h = setup({client, config: {limits: {requestsPerDay: 1}}, admin: true});
  t.after(() => h.vault.close());

  let out = await h.dispatch("!对话", {eventId: "say-0"});
  assert.match(out.reply, /!对话 <内容>/);

  out = await h.dispatch("!对话 你好", {eventId: "say-1"});
  assert.equal(out.status, "HANDLED");
  await h.engine.drain();
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].messages.filter(message => message.role === "user"), [{role: "user", content: "你好"}]);
  assert.deepEqual(h.replies.slice(1), ["收到你的消息"]);
  const rows = h.store.recentMessages(PRIVATE, 10);
  assert.deepEqual(rows.map(row => row.role), ["user", "assistant"]);
  assert.equal(rows[0].senderId, "mock:1");
  assert.equal(rows[0].text, "你好");

  // 防回归：!对话 成功回复后立刻 !状态，其「额度」显示必须等于 store.getUsage(sessionId, dayKey(Date.now()))?.requests（时钟一致，杜绝 1970 现象）
  const todayRequests = h.store.getUsage(PRIVATE, dayKey(Date.now()))?.requests;
  assert.equal(todayRequests, 1);
  assert.equal(h.store.getUsage(PRIVATE, "1970-01-01"), null);
  const statusOut = await h.dispatch("!状态", {eventId: "say-status"});
  assert.equal(statusOut.status, "HANDLED");
  assert.ok(statusOut.reply.includes("额度: " + todayRequests + "/1"));

  out = await h.dispatch("!说 ltoken=abc", {eventId: "say-2"});
  assert.match(out.reply, /已拒绝/);
  assert.equal(client.calls.length, 1);
  assert.equal(h.store.recentMessages(PRIVATE, 10).length, 2);

  out = await h.dispatch("!说 再问一句", {eventId: "say-3"});
  assert.match(out.reply, /今日额度已用完/);
  assert.equal(client.calls.length, 1);
  assert.equal(h.store.recentMessages(PRIVATE, 10).length, 2);

  out = await h.dispatch("!策略设置 乱写", {eventId: "pol-1"});
  assert.match(out.reply, /用法/);
  out = await h.dispatch("!策略设置 mention", {eventId: "pol-2"});
  assert.match(out.reply, /只接受 off 或 all/);
  out = await h.dispatch("!策略设置 off", {eventId: "pol-3"});
  assert.match(out.reply, /已设为 off/);
  assert.match(out.reply, /记录与回复/);
  assert.equal(h.store.getSession(PRIVATE).policy, "off");

  const frozen = h.store.countMessages(PRIVATE);
  await h.dispatch("off 之后的普通消息", {eventId: "pol-4"});
  assert.equal(h.store.countMessages(PRIVATE), frozen);

  const group = {isGroup: true, groupId: "555", unifiedUserId: "mock:2", sender: {id: "2", name: "群友"}};
  out = await h.dispatch("!策略设置 all", {eventId: "pol-g1", ...group});
  assert.equal(out.status, "DENIED");
  assert.match(out.reply, /权限拒绝/);

  h.dispatcher.addAdmin("mock:2");
  out = await h.dispatch("!策略设置 all", {eventId: "pol-g2", ...group});
  assert.equal(out.status, "HANDLED");
  assert.match(out.reply, /已设为 all/);
  assert.equal(h.store.getSession(GROUP).policy, "all");
});
