import test from "node:test";
import assert from "node:assert/strict";
import {GameHubDispatcher, IdentityVault} from "../packages/core/src/index.mjs";
import {createModule} from "../packages/plugin/chat-ai/src/index.mjs";
import {ChatStore} from "../packages/plugin/chat-ai/src/store.mjs";
import {characterIdFor, parseCharacterCard} from "../packages/plugin/chat-ai/src/character.mjs";
import {buildPrompt} from "../packages/plugin/chat-ai/src/prompt.mjs";

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

const v2Card = {
  spec: "chara_card_v2",
  data: {
    name: "小助手",
    description: "你是群里的 AI 小助手，负责简洁回答。",
    personality: "温和、直接",
    scenario: "群聊答疑",
    first_mes: "你好呀",
    mes_example: "<START>\n{{user}}: 在吗\n{{char}}: 在的",
    system_prompt: "回答保持简短",
    post_history_instructions: "不要出戏",
    tags: ["聊天", "日常"],
    extra_unknown: "ignored"
  }
};

test("人物卡：V2 与扁平格式都能取到白名单字段，未知字段只警告", async () => {
  const parsed = parseCharacterCard(v2Card, {owner: "mock:1"});
  assert.equal(parsed.card.name, "小助手");
  assert.equal(parsed.card.description, v2Card.data.description);
  assert.equal(parsed.card.personality, "温和、直接");
  assert.equal(parsed.card.scenario, "群聊答疑");
  assert.equal(parsed.card.first_mes, "你好呀");
  assert.equal(parsed.card.mes_example, v2Card.data.mes_example);
  assert.equal(parsed.card.system_prompt, "回答保持简短");
  assert.equal(parsed.card.post_history_instructions, "不要出戏");
  assert.deepEqual(parsed.card.tags, ["聊天", "日常"]);
  assert.equal(parsed.id, "小助手");
  assert.ok(parsed.warnings.some(warning => warning.includes("extra_unknown")));
  assert.ok(!parsed.warnings.some(warning => warning.includes("spec")));

  const flat = parseCharacterCard({name: "Flat", description: "扁平格式", personality: "冷静", tags: ["a", "b"]});
  assert.equal(flat.card.name, "Flat");
  assert.equal(flat.card.description, "扁平格式");
  assert.equal(flat.card.personality, "冷静");
  assert.deepEqual(flat.card.tags, ["a", "b"]);
  assert.deepEqual(flat.warnings, []);

  // JSON 字符串入口
  const fromString = parseCharacterCard(JSON.stringify({name: "Str"}), {owner: "o"});
  assert.equal(fromString.card.name, "Str");
  assert.throws(() => parseCharacterCard("{not json"), /JSON/);
  assert.throws(() => parseCharacterCard([]), /JSON 对象/);
});

test("人物卡：长设定完整保留，显示名称限长，超过1 MiB拒绝", async () => {
  const parsed = parseCharacterCard({name: "长".repeat(80), description: "x".repeat(5000), tags: Array.from({length: 30}, (_, index) => "t" + index)});
  assert.equal(Array.from(parsed.card.name).length, 60);
  assert.equal(Array.from(parsed.card.description).length, 5000);
  assert.equal(parsed.card.tags.length, 20);
  assert.ok(parsed.warnings.some(warning => warning.includes("name") && warning.includes("截断")));
  assert.ok(!parsed.warnings.some(warning => warning.includes("description")));
  assert.ok(parsed.warnings.some(warning => warning.includes("tags")));
  assert.throws(() => parseCharacterCard({spec: "chara_card_v2", data: {name: "big", description: "x".repeat(1048577)}}), /1 MiB/);
});

test("人物 id：稳定、限长，name 为空时用 sha256 前缀", async () => {
  assert.equal(characterIdFor({name: "角色 A!"}, "o"), "角色-A");
  assert.equal(characterIdFor({name: "角色 A!"}, "o"), characterIdFor({name: "角色 A!"}, "other"));
  assert.ok(Array.from(characterIdFor({name: "名".repeat(100)}, "o")).length <= 32);
  assert.match(characterIdFor({name: ""}, "owner-1"), /^char-[0-9a-f]{8}$/);
  assert.notEqual(characterIdFor({name: ""}, "owner-1"), characterIdFor({name: ""}, "owner-2"));
});

test("prompt 组装：人物设定进 system，硬约束存在，群聊带发送者前缀，且不串会话", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const store = new ChatStore(vault);
  const sessionA = {sessionId: "mock:999:private:mock:1", platform: "mock", botId: "999", scope: "private", scopeId: "mock:1"};
  const sessionB = {sessionId: "mock:999:private:mock:2", platform: "mock", botId: "999", scope: "private", scopeId: "mock:2"};
  store.ensureSession(sessionA);
  store.ensureSession(sessionB);
  store.insertMessage({sessionId: sessionA.sessionId, eventId: "a-1", role: "user", text: "会话一的话", senderName: "小明"});
  store.insertMessage({sessionId: sessionA.sessionId, eventId: "a-2", role: "assistant", text: "会话一的回复", senderName: null});
  store.insertMessage({sessionId: sessionB.sessionId, eventId: "b-1", role: "user", text: "会话二的话", senderName: "小红"});

  const character = parseCharacterCard(v2Card, {owner: "mock:1"}).card;
  const prompt = buildPrompt({character, history: store.recentMessages(sessionA.sessionId, 20), maxMessages: 20, maxCharsPerMessage: 100, isGroup: true});
  assert.match(prompt.system, /纯文本/);
  assert.match(prompt.system, /CQ 码/);
  assert.match(prompt.system, /不要声称已经执行了系统操作/);
  assert.ok(prompt.system.includes("小助手"));
  assert.ok(prompt.system.includes(v2Card.data.description));
  assert.deepEqual(prompt.messages, [
    {role: "user", content: "[小明] 会话一的话"},
    {role: "assistant", content: "会话一的回复"}
  ]);
  assert.ok(!prompt.messages.some(message => message.content.includes("会话二的话")));
  assert.ok(!prompt.messages.some(message => message.content.includes(v2Card.data.description)));

  // 无人物：通用助手人设；窗口只取最近 N 条
  const plain = buildPrompt({history: store.recentMessages(sessionA.sessionId, 20), style: "x"});
  assert.match(plain.system, /助手/);
  assert.equal(plain.system.includes("角色名"), false);
  const windowed = buildPrompt({history: store.recentMessages(sessionA.sessionId, 20), maxMessages: 1, maxCharsPerMessage: 100});
  assert.deepEqual(windowed.messages, [{role: "assistant", content: "会话一的回复"}]);
});

test("人物导入：群聊拒绝、私聊成功、切换后会话绑定人物", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const {dispatch, store} = setup({vault, admin: true});
  const cardJson = JSON.stringify({name: "群卡", description: "群卡设定内容XYZ"});

  let output = await dispatch("!人物导入 " + cardJson, {isGroup: true, groupId: "g1"});
  assert.equal(output.status, "HANDLED");
  assert.match(output.reply, /私聊/);
  assert.equal(store.listCharacters().length, 0); // 新安装不预置个人卡片

  output = await dispatch("!人物导入 " + cardJson);
  assert.equal(output.status, "HANDLED");
  assert.match(output.reply, /已导入人物卡 群卡/);
  assert.equal(store.listCharacters().length, 1);

  output = await dispatch("!人物列表");
  assert.match(output.reply, /群卡/);

  output = await dispatch("!人物切换 群卡");
  assert.match(output.reply, /已切换人物: 群卡/);
  const session = store.getSession("mock:999:private:mock:1");
  assert.equal(session.characterId, "群卡");
  assert.equal(session.epoch, 1);

  const bound = store.getCharacter("群卡");
  const prompt = buildPrompt({character: bound.card, history: [], maxMessages: 20, maxCharsPerMessage: 100});
  assert.ok(prompt.system.includes("群卡设定内容XYZ"));

  output = await dispatch("!人物卸下");
  assert.match(output.reply, /已卸下人物卡/);
  assert.equal(store.getSession("mock:999:private:mock:1").characterId, null);
  assert.equal(store.getSession("mock:999:private:mock:1").epoch, 2);

  output = await dispatch("!人物切换 不存在");
  assert.match(output.reply, /未找到人物卡/);
});

test("装配不预置个人卡片，重新装配保留用户卡和会话绑定",t=>{
  const vault=new IdentityVault(":memory:");t.after(()=>vault.close());
  const first=createModule({vault,fetchImpl:()=>{throw new Error("装配不应联网");}}),store=first.services.store;
  assert.deepEqual(store.listCharacters(),[]);
  const card={name:"用户测试卡",description:"仅供自动化测试的私有设定"};
  store.saveCharacter({id:"user-test",name:card.name,card,owner:"mock:owner"});
  store.ensureSession({sessionId:"private-test",platform:"mock",botId:"bot",scope:"private",scopeId:"mock:owner"});store.setCharacter("private-test","user-test");
  const before=store.getCharacter("user-test"),session=store.getSession("private-test");
  const second=createModule({vault});
  assert.deepEqual(second.services.store.getCharacter("user-test"),before);
  assert.deepEqual(second.services.store.getSession("private-test"),session);
  assert.equal(second.services.store.listCharacters().length,1);
});
