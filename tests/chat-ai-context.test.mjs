import test from "node:test";
import assert from "node:assert/strict";
import {GameHubDispatcher, IdentityVault} from "../packages/core/src/index.mjs";
import {createModule} from "../packages/plugin/chat-ai/src/index.mjs";

let sequence = 0;
const event = (text, overrides = {}) => ({
  eventId: "ev-" + (++sequence), messageId: "msg-" + sequence, platform: "mock", botId: "999",
  unifiedUserId: "mock:1", cleanText: text, sender: {id: "1", name: "小明"},
  reply: async () => ({success: true}), ...overrides
});

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

const PRIVATE = "mock:999:private:mock:1";

test("observer 记录：event_id 去重、跨 bot/群/私聊隔离、自身与敏感/空文本不入库", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const {dispatch, store} = setup({vault});

  await dispatch("你好", {eventId: "dup-1"});
  await dispatch("你好", {eventId: "dup-1"});
  assert.equal(store.countMessages(PRIVATE), 1);

  await dispatch("另一个机器人", {eventId: "bot-2", botId: "1000"});
  assert.equal(store.countMessages("mock:1000:private:mock:1"), 1);
  assert.equal(store.countMessages(PRIVATE), 1);

  await dispatch("群里说话", {eventId: "group-1", isGroup: true, groupId: "555"});
  assert.equal(store.countMessages("mock:999:group:555"), 1);
  assert.equal(store.countMessages(PRIVATE), 1);

  await dispatch("另一个人的私聊", {eventId: "other-1", unifiedUserId: "mock:2", sender: {id: "2", name: "小红"}});
  assert.equal(store.countMessages("mock:999:private:mock:2"), 1);

  // 机器人自己的消息
  await dispatch("机器人自言自语", {eventId: "self-1", sender: {id: "999", name: "bot"}});
  assert.equal(store.countMessages(PRIVATE), 1);

  // 敏感文本与空文本
  await dispatch("看这个 authkey=abc123", {eventId: "secret-1"});
  await dispatch("手机号 ltoken=xyz", {eventId: "secret-2"});
  await dispatch("   ", {eventId: "empty-1"});
  await dispatch("", {eventId: "empty-2"});
  assert.equal(store.countMessages(PRIVATE), 1);

  // 群聊缺 groupId：无法构造会话键，观察器跳过且不抛
  const output = await dispatch("没有群号的群消息", {eventId: "bad-group", isGroup: true});
  assert.equal(output.status, "NOT_MATCHED");
});

test("超过窗口上限按 seq 裁剪到 maxMessages", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const {dispatch, store} = setup({vault, config: {retention: {maxMessages: 4}}});
  for (let index = 1; index <= 6; index += 1) await dispatch("消息" + index, {eventId: "m-" + index});
  assert.equal(store.countMessages(PRIVATE), 4);
  assert.deepEqual(store.recentMessages(PRIVATE, 10).map(message => message.text), ["消息3", "消息4", "消息5", "消息6"]);
});

test("contextShow 只显示条数不含正文；contextClear 清空本会话并递增 epoch", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const {dispatch, store} = setup({vault, admin: true});
  await dispatch("秘密正文XYZ", {eventId: "c-1"});
  await dispatch("另一个机器人的消息", {eventId: "c-2", botId: "1000"});

  let output = await dispatch("!上下文");
  assert.equal(output.status, "HANDLED");
  assert.match(output.reply, /消息: 1 \/ 20 条/);
  assert.match(output.reply, /策略: all/);
  assert.equal(output.reply.includes("秘密正文XYZ"), false);

  assert.equal(store.getSession(PRIVATE).epoch, 0);
  output = await dispatch("!清空上下文");
  assert.match(output.reply, /已清空本会话上下文（1 条）/);
  assert.equal(store.countMessages(PRIVATE), 0);
  assert.equal(store.getSession(PRIVATE).epoch, 1);
  // 其它会话不受影响
  assert.equal(store.countMessages("mock:1000:private:mock:1"), 1);

  output = await dispatch("!上下文");
  assert.match(output.reply, /消息: 0 \/ 20 条/);
});

test("群聊上下文指令：非管理员 DENIED 并提示私聊，管理员可查看", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const {dispatcher, dispatch} = setup({vault});
  const group = {isGroup: true, groupId: "777", unifiedUserId: "mock:2", sender: {id: "2", name: "群友"}};
  await dispatch("群里的普通消息", {eventId: "g-1", ...group});

  let output = await dispatch("!上下文", {eventId: "g-2", ...group});
  assert.equal(output.status, "DENIED");
  assert.match(output.reply, /权限拒绝/);

  output = await dispatch("!清空上下文", {eventId: "g-3", ...group});
  assert.equal(output.status, "DENIED");
  assert.match(output.reply, /权限拒绝/);

  dispatcher.addAdmin("mock:2");
  output = await dispatch("!上下文", {eventId: "g-4", ...group});
  assert.equal(output.status, "HANDLED");
  assert.match(output.reply, /消息: 1 \/ 20 条/);

  output = await dispatch("!清空上下文", {eventId: "g-5", ...group});
  assert.equal(output.status, "HANDLED");
  assert.match(output.reply, /已清空本会话上下文（1 条）/);
});

test("策略 off 同时停止记录：改回策略后恢复记录", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const {dispatch, store} = setup({vault});
  await dispatch("第一条", {eventId: "p-1"});
  assert.equal(store.countMessages(PRIVATE), 1);

  store.setPolicy(PRIVATE, "off");
  const frozen = store.countMessages(PRIVATE);
  await dispatch("off 之后不应记录", {eventId: "p-2"});
  assert.equal(store.countMessages(PRIVATE), frozen);

  store.setPolicy(PRIVATE, "mention");
  await dispatch("恢复后应记录", {eventId: "p-3"});
  assert.equal(store.countMessages(PRIVATE), frozen + 1);
  assert.equal(store.recentMessages(PRIVATE, 10).at(-1).text, "恢复后应记录");
});
