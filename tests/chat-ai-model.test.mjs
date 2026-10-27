import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {GameHubDispatcher, IdentityVault} from "../packages/core/src/index.mjs";
import {createModule} from "../packages/plugin/chat-ai/src/index.mjs";
import {ChatStore} from "../packages/plugin/chat-ai/src/store.mjs";
import {clearAllDrafts} from "../packages/plugin/chat-ai/src/wizard.mjs";

let sequence = 0;
const event = (text, overrides = {}) => ({
  eventId: "ev-" + (++sequence), messageId: "msg-" + sequence, platform: "mock", botId: "999",
  unifiedUserId: "mock:1", cleanText: text, sender: {id: "1", name: "小明"},
  reply: async () => ({success: true}), ...overrides
});

const setup = ({vault, config = {}, admin = false} = {}) => {
  clearAllDrafts();
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

test("模型档案：非管理员 DENIED 且不写入，管理员向导增改删查", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const {dispatcher, dispatch, store} = setup({vault});

  // 非管理员执行模型指令全部 DENIED
  let output = await dispatch("!模型新增");
  assert.equal(output.status, "DENIED");
  assert.match(output.reply, /权限拒绝/);
  assert.equal(store.listModels().length, 0);

  // 授权管理员
  dispatcher.addAdmin("mock:1");

  // 向导创建档案 main
  output = await dispatch("!模型新增");
  assert.equal(output.status, "HANDLED");
  assert.match(output.reply, /第 1\/4 步/);

  await dispatch("main");
  await dispatch("https://api.example.com/v1");
  await dispatch("gpt-4o-mini");
  output = await dispatch("CHATAI_KEY_MAIN");
  assert.match(output.reply, /配置摘要/);
  assert.match(output.reply, /CHATAI_KEY_\*\*\*/);
  assert.equal(output.reply.includes("CHATAI_KEY_MAIN"), false);

  output = await dispatch("确认");
  assert.match(output.reply, /【模型新增成功】/);

  const saved = store.getModel("main");
  assert.ok(saved);
  assert.equal(saved.endpoint, "https://api.example.com/v1");
  assert.equal(saved.model, "gpt-4o-mini");
  assert.equal(saved.apiKeyEnv, "CHATAI_KEY_MAIN");

  // 尝试新增已存在别名 -> 向导第 1 步提示已存在
  await dispatch("!模型新增");
  output = await dispatch("main");
  assert.match(output.reply, /已存在/);
  await dispatch("取消");

  // !模型修改 向导
  output = await dispatch("!模型修改 main");
  assert.match(output.reply, /第 1\/3 步/);
  // 跳过端点
  await dispatch("跳过");
  // 修改模型为 gpt-4o
  await dispatch("gpt-4o");
  // 跳过密钥
  output = await dispatch("跳过");
  assert.match(output.reply, /配置摘要/);
  output = await dispatch("确认");
  assert.match(output.reply, /【模型修改成功】/);

  const updated = store.getModel("main");
  assert.equal(updated.model, "gpt-4o");

  // !模型列表
  output = await dispatch("!模型列表");
  assert.match(output.reply, /main/);
  assert.match(output.reply, /gpt-4o/);
  assert.match(output.reply, /CHATAI_KEY_\*\*\*/);
  assert.equal(output.reply.includes("CHATAI_KEY_MAIN"), false);
  assert.equal(/sk-[A-Za-z0-9]/.test(output.reply), false);

  // !模型删除
  output = await dispatch("!模型删除 nope");
  assert.match(output.reply, /未找到模型档案 nope/);
  output = await dispatch("!模型删除 main");
  assert.match(output.reply, /已删除模型档案 main/);
  assert.equal(store.getModel("main"), null);
  assert.equal(store.listModels().length, 0);
});

test("模型档案持久化：关闭数据库后重开仍可读", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "game-hub-chat-ai-"));
  const file = path.join(dir, "vault.sqlite");
  let vault = new IdentityVault(file);
  let reopened = null;
  t.after(async () => {
    try { vault?.close(); } catch {}
    try { reopened?.close(); } catch {}
    await fs.rm(dir, {recursive: true, force: true});
  });
  const {store} = setup({vault, admin: true});
  store.saveModel({
    id: "persist",
    endpoint: "https://api.example.com/v1",
    model: "gpt-test",
    apiKeyEnv: "CHATAI_KEY_MAIN"
  });

  vault.close();
  vault = null;
  reopened = new IdentityVault(file);
  const reStore = new ChatStore(reopened);
  const saved = reStore.getModel("persist");
  assert.ok(saved);
  assert.equal(saved.model, "gpt-test");
  assert.equal(saved.endpoint, "https://api.example.com/v1");
  assert.equal(saved.apiKeyEnv, "CHATAI_KEY_MAIN");
});

test("参数缺失时给出用 ctx.commands.format 生成的用法提示", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const {dispatch} = setup({vault, admin: true});
  for (const [text, expected] of [
    ["!模型修改", /!模型修改 <别名>/],
    ["!模型删除", /!模型删除 <别名>/]
  ]) {
    const output = await dispatch(text);
    assert.equal(output.status, "HANDLED", text);
    assert.match(output.reply, expected, text);
  }
});
