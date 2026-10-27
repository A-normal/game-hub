import test from "node:test";
import assert from "node:assert/strict";
import {GameHubDispatcher, IdentityVault} from "../packages/core/src/index.mjs";
import {createModule} from "../packages/plugin/chat-ai/src/index.mjs";
import {clearAllDrafts} from "../packages/plugin/chat-ai/src/wizard.mjs";

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

const setup = ({vault, config = {}, now = Date.now} = {}) => {
  clearAllDrafts();
  const dispatcher = new GameHubDispatcher({vault, adminToken: "hub-secret"});
  dispatcher.addAdmin("mock:admin");
  const module = createModule({config, vault, dispatcher, now});
  dispatcher.registerPlugin(module);
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

test("!模型新增分步向导：4步+确认成功保存，向导输入不入库", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const {dispatch, store} = setup({vault});

  // 1. 发起向导
  let out = await dispatch("!模型新增");
  assert.equal(out.status, "HANDLED");
  assert.match(out.reply, /第 1\/4 步/);

  // 2. 步骤 1：别名
  out = await dispatch("main");
  assert.equal(out.status, "HANDLED");
  assert.match(out.reply, /第 2\/4 步/);

  // 3. 步骤 2：端点
  out = await dispatch("https://api.184829.xyz/v1");
  assert.equal(out.status, "HANDLED");
  assert.match(out.reply, /第 3\/4 步/);

  // 4. 步骤 3：模型 ID
  out = await dispatch("gemini-3.8-flash-high");
  assert.equal(out.status, "HANDLED");
  assert.match(out.reply, /第 4\/4 步/);

  // 5. 步骤 4：密钥环境变量名
  out = await dispatch("CHATAI_KEY_MAIN");
  assert.equal(out.status, "HANDLED");
  assert.match(out.reply, /配置摘要/);
  assert.match(out.reply, /main/);
  assert.match(out.reply, /CHATAI_KEY_\*\*\*/);

  // 6. 确认保存
  out = await dispatch("确认");
  assert.equal(out.status, "HANDLED");
  assert.match(out.reply, /【模型新增成功】/);

  // 验证 store 数据
  const saved = store.getModel("main");
  assert.ok(saved);
  assert.equal(saved.id, "main");
  assert.equal(saved.endpoint, "https://api.184829.xyz/v1");
  assert.equal(saved.model, "gemini-3.8-flash-high");
  assert.equal(saved.apiKeyEnv, "CHATAI_KEY_MAIN");

  // 验证向导输入未被 observer 写入 chat_messages
  const msgCount = store.countMessages("mock:999:private:mock:admin");
  assert.equal(msgCount, 0);
});

test("向导校验重试、重来与取消", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const {dispatch, store} = setup({vault});

  await dispatch("!模型新增");

  // 步骤 1 非法别名
  let out = await dispatch("Bad_Alias!");
  assert.match(out.reply, /档案别名格式不正确/);

  // 正确别名
  await dispatch("test1");

  // 步骤 2 非法 URL
  out = await dispatch("not a url");
  assert.match(out.reply, /接口地址不合法/);

  // 步骤 2 query 参数拒绝
  out = await dispatch("https://api.example.com/v1?token=123");
  assert.match(out.reply, /query 参数/);

  // 正确端点
  await dispatch("https://api.example.com/v1");

  // 步骤 3 模型 ID
  await dispatch("my-model");

  // 步骤 4 敏感变量名被拒
  out = await dispatch("VAULT_SECRET");
  assert.match(out.reply, /密钥环境变量名不合法/);

  // 正确密钥变量名
  out = await dispatch("CHATAI_KEY_TEST");
  assert.match(out.reply, /配置摘要/);

  // 重来：清空重填回到第 1 步
  out = await dispatch("重来");
  assert.match(out.reply, /第 1\/4 步/);

  // 随时取消
  out = await dispatch("取消");
  assert.match(out.reply, /已取消模型配置向导/);
  assert.equal(store.listModels().length, 0);
});

test("!模型修改：依次询问并支持「跳过」保留原值", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const {dispatch, store} = setup({vault});

  // 预置档案
  store.saveModel({
    id: "edit_me",
    endpoint: "https://api.example.com/v1",
    model: "original-model",
    apiKeyEnv: "CHATAI_KEY_ORIGINAL"
  });

  // 未提供别名
  let out = await dispatch("!模型修改");
  assert.match(out.reply, /!模型修改 <别名>/);

  // 不存在的别名
  out = await dispatch("!模型修改 not_exist");
  assert.match(out.reply, /未找到模型档案 not_exist/);

  // 启动修改向导
  out = await dispatch("!模型修改 edit_me");
  assert.match(out.reply, /第 1\/3 步：接口地址/);
  assert.match(out.reply, /跳过/);

  // 步骤 1 跳过接口地址
  out = await dispatch("跳过");
  assert.match(out.reply, /第 2\/3 步：模型标识/);

  // 步骤 2 修改模型标识
  out = await dispatch("updated-model-v2");
  assert.match(out.reply, /第 3\/3 步：密钥环境变量名/);

  // 步骤 3 跳过密钥变量名
  out = await dispatch("跳过");
  assert.match(out.reply, /配置摘要/);
  assert.match(out.reply, /updated-model-v2/);

  // 确认修改
  out = await dispatch("确认");
  assert.match(out.reply, /【模型修改成功】/);

  const updated = store.getModel("edit_me");
  assert.equal(updated.endpoint, "https://api.example.com/v1");
  assert.equal(updated.model, "updated-model-v2");
  assert.equal(updated.apiKeyEnv, "CHATAI_KEY_ORIGINAL");
});

test("群聊中发起向导被拒、TTL 10 分钟过期、中途权限撤销", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());

  let currentTime = 1000000;
  const now = () => currentTime;
  const {dispatcher, dispatch} = setup({vault, now});

  // 群聊发起被拒
  let out = await dispatch("!模型新增", {isGroup: true, groupId: "1001"});
  assert.match(out.reply, /私聊/);

  // 私聊发起
  out = await dispatch("!模型新增");
  assert.match(out.reply, /第 1\/4 步/);

  // 时间前进 11 分钟 (660,000 ms)
  currentTime += 11 * 60 * 1000;

  // 再次发送普通文本：向导已过期，不作为向导输入消费
  out = await dispatch("main");
  assert.notEqual(out.reply, "");
  assert.doesNotMatch(out.reply, /第 2\/4 步/);

  // 重新发起向导并在第 2 步撤销管理员权限
  await dispatch("!模型新增");
  await dispatch("main2");
  dispatcher.removeAdmin("mock:admin");

  out = await dispatch("https://api.example.com/v1");
  assert.match(out.reply, /管理员权限已失效/);
});
