import test from "node:test";
import assert from "node:assert/strict";
import {GameHubDispatcher, IdentityVault} from "../packages/core/src/index.mjs";
import chatAi, {DEFAULT_CONFIG, createLogger, createModule, configSchema, normalizeConfig} from "../packages/plugin/chat-ai/src/index.mjs";
import {ChatStore} from "../packages/plugin/chat-ai/src/store.mjs";
import {clipText, dayKey, isSensitiveText, resolvePolicy, sessionKeyOf} from "../packages/plugin/chat-ai/src/session.mjs";
import {validateConfig} from "../packages/core/src/runtime/config-schema.mjs";

const PLUGIN_TABLES = "SELECT name FROM sqlite_master WHERE name IN ('chat_sessions','chat_messages','chat_characters','chat_models','chat_usage') ORDER BY name";
const tableNames = vault => vault.db.prepare(PLUGIN_TABLES).all().map(row => row.name);

let sequence = 0;
const event = (text, overrides = {}) => ({
  eventId: "ev-" + (++sequence), messageId: "msg-" + sequence, platform: "mock", botId: "999",
  unifiedUserId: "mock:1", cleanText: text, sender: {id: "1", name: "小明"},
  reply: async () => ({success: true}), ...overrides
});

/** 装配：真实 dispatcher + 插件模块，返回可直接断言的 dispatch 包装。 */
const setup = ({vault, config = {}, admin = false} = {}) => {
  const dispatcher = new GameHubDispatcher({vault, adminToken: "secret"});
  const module = createModule({config, vault, dispatcher});
  dispatcher.registerPlugin(module);
  if (admin) dispatcher.addAdmin("mock:1");
  const replies = [];
  const dispatch = async (text, overrides = {}) => {
    const before = replies.length;
    const output = await dispatcher.dispatch(event(text, {
      reply: async message => { replies.push(String(message)); return {success: true}; },
      ...overrides
    }));
    return {status: output.status, reply: replies.slice(before).join("\n")};
  };
  return {dispatcher, module, store: module.services.store, replies, dispatch};
};

test("导入与 createModule 的副作用边界：导入不建表，createModule 建表但不发请求", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  assert.deepEqual(tableNames(vault), []);
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error("测试中不允许联网"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const module = createModule({config: {}, vault});
  assert.equal(fetches, 0);
  assert.deepEqual(tableNames(vault), ["chat_characters", "chat_messages", "chat_models", "chat_sessions", "chat_usage"]);
  await module.start();
  await module.stop();
  assert.equal(fetches, 0);
  assert.equal(chatAi.id, "chat-ai");
});

test("createModule 返回 id/kind/contractVersion/routes/providers/services，log 默认保留警告", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const module = createModule({config: {}, vault, dispatcher: null});
  assert.equal(module.id, "chat-ai");
  assert.equal(module.kind, "plugin");
  assert.equal(module.contractVersion, 1);
  assert.equal(module.name, "聊天 AI");
  assert.deepEqual(module.defaultNamespace, {prefix: "!", aliases: ["！"], priority: 50});
  assert.deepEqual(module.providers, [{id: "llm", capabilities: ["chat"]}]);
  assert.ok(module.services.store instanceof ChatStore);
  assert.deepEqual(module.services.config, DEFAULT_CONFIG);
  assert.equal(typeof module.start, "function");
  assert.equal(typeof module.stop, "function");
  const byId = new Map(module.routes.map(route => [route.id, route]));
  for (const id of ["help", "status", "modelList", "modelAdd", "modelSet", "modelRemove", "characterList", "characterImport", "characterUse", "characterOff", "contextShow", "contextClear", "observe", "reply"]) assert.ok(byId.has(id), id);
  assert.equal(byId.get("observe").stage, "observer");
  assert.equal(byId.get("reply").stage, "fallback");
  assert.equal(byId.get("reply").action(), false);
  assert.equal(typeof byId.get("modelAdd").action, "function");
  assert.equal(typeof byId.get("characterImport").action, "function");
  assert.equal(typeof byId.get("help").action, "function");
  // 警告始终输出；debug 开关只控制诊断细节
  const originalWarn = console.warn;
  const captured = [];
  console.warn = message => captured.push(String(message));
  t.after(() => { console.warn = originalWarn; });
  createLogger({}).debug("不应输出的详细诊断");
  assert.deepEqual(captured, []);
  createLogger({}).warn("必要警告");
  assert.equal(captured.length,1);
  createLogger({debug: true}).warn("会话键=abc code=LLM_TIMEOUT 耗时=12ms");
  assert.equal(captured.length, 2);
  assert.match(captured[0], /\[chat-ai\]/);
});

test("建表可重入：同一 vault 多次装配不报错且保留数据", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const first = createModule({config: {}, vault});
  first.services.store.saveModel({id: "main", endpoint: "https://api.example.com/x", model: "m", apiKeyEnv: "CHATAI_KEY_MAIN"});
  const second = createModule({config: {}, vault});
  assert.equal(second.services.store.getModel("main").model, "m");
  new ChatStore(vault);
  assert.equal(tableNames(vault).length, 5);
});

test("resolvePolicy：会话显式策略优先，否则按作用域取默认；无法判定时 off", async () => {
  const config = normalizeConfig({});
  assert.equal(resolvePolicy({scope: "group", policy: null}, config), "mention");
  assert.equal(resolvePolicy({scope: "private", policy: null}, config), "all");
  assert.equal(resolvePolicy({scope: "group", policy: "off"}, config), "off");
  assert.equal(resolvePolicy({scope: "private", policy: "all"}, config), "all");
  assert.equal(resolvePolicy(null, config), "off");
  const custom = normalizeConfig({policy: {groupDefault: "all", privateDefault: "off"}});
  assert.equal(resolvePolicy({scope: "group", policy: null}, custom), "all");
  assert.equal(resolvePolicy({scope: "private", policy: null}, custom), "off");
  assert.equal(resolvePolicy({scope: "group", policy: "bogus"}, custom), "all");
});

test("sessionKeyOf：群聊/私聊/多机器人隔离，缺 groupId 返回 null", async () => {
  assert.equal(sessionKeyOf({platform: "qq", botId: "123", isGroup: true, groupId: "456"}), "qq:123:group:456");
  assert.equal(sessionKeyOf({platform: "qq", botId: "123", isGroup: false, unifiedUserId: "qq:9"}), "qq:123:private:qq:9");
  assert.equal(sessionKeyOf({platform: "qq", isGroup: true, groupId: "456"}), "qq:-:group:456");
  assert.equal(sessionKeyOf({platform: "qq", isGroup: true, groupId: ""}), null);
  assert.equal(sessionKeyOf({platform: "qq", isGroup: true}), null);
  assert.equal(sessionKeyOf({platform: "qq", isGroup: false, unifiedUserId: ""}), null);
  assert.equal(sessionKeyOf(null), null);
  const one = sessionKeyOf({platform: "qq", botId: "1", isGroup: true, groupId: "g"});
  const two = sessionKeyOf({platform: "qq", botId: "2", isGroup: true, groupId: "g"});
  assert.notEqual(one, two);
});

test("isSensitiveText 命中凭据/链接/CQ 码，普通文本不误伤", async () => {
  for (const text of ["ltoken=abc", "ltoken_v2=abc", "stoken=x", "cookie_token=y", "authkey=z", "authkey_ver=1", "login_ticket=t", "Cookie: a=b", "看这个 [CQ:at,qq=1] 呀"]) {
    assert.equal(isSensitiveText(text), true, text);
  }
  for (const text of ["普通文本", "ltoken 没有等号", "auth key 分开写", "[CQ 缺少冒号]", ""]) {
    assert.equal(isSensitiveText(text), false, text);
  }
  assert.equal(isSensitiveText(undefined), false);
});

test("clipText 剥离 CQ 段与控制字符并截断；dayKey 可注入 now", async () => {
  assert.equal(clipText("  hello\u0000 world  ", 100), "hello world");
  assert.equal(clipText("看这个 [CQ:image,file=a.jpg] 图", 100).includes("[CQ:"), false);
  assert.equal(clipText("前缀[CQ:image,file=x", 100), "前缀");
  assert.equal(clipText("a".repeat(10), 4), "aaaa");
  assert.equal(clipText("😀😀😀", 2), "😀😀");
  assert.equal(clipText(undefined, 10), "");
  assert.equal(dayKey(new Date(2026, 9, 26, 23, 30).getTime()), "2026-10-26");
  assert.equal(dayKey(new Date(2026, 0, 1, 0, 5).getTime()), "2026-01-01");
});

test("help/status 由 commands.format 生成，命名空间变更后输出随之变化", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const {dispatcher, dispatch} = setup({vault, config: {retention: {maxMessages: 30}}, admin: true});
  let output = await dispatch("!帮助");
  assert.equal(output.status, "HANDLED");
  assert.match(output.reply, /!帮助/);
  assert.match(output.reply, /!状态/);
  assert.match(output.reply, /!模型新增/);
  assert.match(output.reply, /!人物导入/);
  assert.match(output.reply, /!清空上下文/);
  // TASK-07 起「说」「策略设置」已实现，必须出现在帮助里；未实现的能力不得出现。
  assert.match(output.reply, /!对话/);
  assert.match(output.reply, /!策略设置/);
  const commandLines = output.reply.split("\n").filter(line => line.startsWith("  "));
  for (const cmdLine of commandLines) {
    assert.ok(cmdLine.trim().startsWith("!"));
  }

  output = await dispatch("!状态");
  assert.match(output.reply, /mock:999:private:mock:1/);
  assert.match(output.reply, /策略: all/);
  assert.match(output.reply, /模型档案: 0 个/);
  assert.match(output.reply, /上下文窗口: 30 条/);
  assert.match(output.reply, /调试: 关/);

  dispatcher.setNamespace("chat-ai", {prefix: "%", aliases: []});
  output = await dispatch("%帮助");
  assert.match(output.reply, /%帮助/);
  assert.ok(!output.reply.includes("!帮助"));
  output = await dispatch("%状态");
  assert.equal(output.status, "HANDLED");
  assert.match(output.reply, /帮助: %帮助/);
});

test("normalizeConfig 默认值/合并与 configSchema 越界拒绝", async () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({retention: {maxMessages: 50}}).retention, {maxMessages: 50, maxCharsPerMessage: 1000});
  assert.equal(normalizeConfig({policy: {groupDefault: "off"}}).policy.groupDefault, "off");
  assert.equal(normalizeConfig({debug: true}).debug, true);
  assert.equal(normalizeConfig({model: {temperature: 1.5}}).model.temperature, 1.5);
  // 越界值回退默认（正常路径上 loader 会先拒绝）
  assert.equal(normalizeConfig({retention: {maxMessages: 999}}).retention.maxMessages, 20);
  assert.equal(normalizeConfig({limits: {requestsPerDay: 0}}).limits.requestsPerDay, 300);

  validateConfig(configSchema, {}, "plugin:chat-ai");
  validateConfig(configSchema, {debug: true, policy: {groupDefault: "off"}}, "plugin:chat-ai");
  assert.throws(() => validateConfig(configSchema, {retention: {maxMessages: 201}}, "plugin:chat-ai"), /above maximum/);
  assert.throws(() => validateConfig(configSchema, {policy: {groupDefault: "sometimes"}}, "plugin:chat-ai"), /unsupported value/);
  assert.throws(() => validateConfig(configSchema, {debug: "yes"}, "plugin:chat-ai"), /expected boolean/);
  assert.throws(() => validateConfig(configSchema, {unknown: true}, "plugin:chat-ai"), /unknown field/);
  assert.throws(() => validateConfig(configSchema, {limits: {requestsPerDay: 0}}, "plugin:chat-ai"), /below minimum/);
});
