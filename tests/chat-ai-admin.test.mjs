import test from "node:test";
import assert from "node:assert/strict";
import {GameHubDispatcher, IdentityVault} from "../packages/core/src/index.mjs";
import {createModule} from "../packages/plugin/chat-ai/src/index.mjs";
import {invalidateAiAdminsCache} from "../packages/plugin/chat-ai/src/admin.mjs";

let sequence = 0;
const event = (text, overrides = {}) => ({
  eventId: "ev-" + (++sequence),
  messageId: "msg-" + sequence,
  platform: "mock",
  botId: "999",
  unifiedUserId: "mock:user1",
  cleanText: text,
  sender: {id: "user1", name: "普通用户"},
  reply: async () => ({success: true}),
  ...overrides
});

const setup = ({vault, config = {}, adminToken = "secret-token"} = {}) => {
  invalidateAiAdminsCache();
  const dispatcher = new GameHubDispatcher({vault, adminToken: "hub-admin-secret"});
  const module = createModule({config, vault, dispatcher});
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

const withEnv = (name, value) => {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
};

test("双管理员权限矩阵：普通用户全被 withAdmin 拦截，系统管理员隐式拥有权限", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const {dispatcher, dispatch} = setup({vault});

  // 普通用户执行常用指令全部 DENIED
  for (const cmd of ["!帮助", "!状态", "!对话 你好", "!模型列表", "!模型新增", "!人物列表", "!策略设置 all", "!上下文"]) {
    const out = await dispatch(cmd);
    assert.equal(out.status, "DENIED", cmd);
    assert.match(out.reply, /【权限拒绝】该指令仅限聊天 AI 管理员/, cmd);
    assert.match(out.reply, /!AI认证/, cmd);
  }

  // 系统管理员隐式拥有所有权限
  dispatcher.addAdmin("mock:admin_sys");
  const sysUser = {unifiedUserId: "mock:admin_sys", sender: {id: "admin_sys", name: "系统管理"}};
  let out = await dispatch("!帮助", sysUser);
  assert.equal(out.status, "HANDLED");
  assert.match(out.reply, /【聊天 AI 指令手册】/);

  out = await dispatch("!状态", sysUser);
  assert.equal(out.status, "HANDLED");
  assert.match(out.reply, /【聊天 AI 状态】/);

  out = await dispatch("!模型列表", sysUser);
  assert.equal(out.status, "HANDLED");
  assert.match(out.reply, /目前没有模型档案/);
});

test("!AI认证：仅私聊，密钥未配置/错误/成功判定", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const {dispatch} = setup({vault});

  // 群聊发起认证被拒
  let out = await dispatch("!AI认证 token123", {isGroup: true, groupId: "1001"});
  assert.equal(out.status, "DENIED");
  assert.match(out.reply, /私聊/);

  // CHATAI_ADMIN_TOKEN 未配置
  const restoreEmpty = withEnv("CHATAI_ADMIN_TOKEN", undefined);
  try {
    out = await dispatch("!AI认证 token123");
    assert.equal(out.status, "DENIED");
    assert.match(out.reply, /未配置 AI 管理员密钥（CHATAI_ADMIN_TOKEN）/);
  } finally {
    restoreEmpty();
  }

  // 配置正确 token
  const restoreEnv = withEnv("CHATAI_ADMIN_TOKEN", "ai-secret-888");
  t.after(restoreEnv);

  // token 错误
  out = await dispatch("!AI认证 wrong-secret");
  assert.equal(out.status, "DENIED");
  assert.match(out.reply, /AI 管理员认证失败：密钥错误！/);

  // 认证成功
  out = await dispatch("!AI认证 ai-secret-888", {unifiedUserId: "mock:ai_user1"});
  assert.equal(out.status, "HANDLED");
  assert.match(out.reply, /【AI 管理员认证成功】当前 AI 管理员共 1 人/);

  // 认证后可以使用管理员指令
  out = await dispatch("!帮助", {unifiedUserId: "mock:ai_user1"});
  assert.equal(out.status, "HANDLED");
  assert.match(out.reply, /【聊天 AI 指令手册】/);
});

test("!AI管理员列表与删除：系统管理员不可删，AI 管理员可删且删除后降权", async t => {
  const vault = new IdentityVault(":memory:");
  t.after(() => vault.close());
  const {dispatcher, dispatch} = setup({vault});

  const restoreEnv = withEnv("CHATAI_ADMIN_TOKEN", "ai-secret-888");
  t.after(restoreEnv);

  // mock:ai_user1 认证
  await dispatch("!AI认证 ai-secret-888", {unifiedUserId: "mock:ai_user1"});
  // mock:ai_user2 认证
  await dispatch("!AI认证 ai-secret-888", {unifiedUserId: "mock:ai_user2"});

  // 添加系统管理员
  dispatcher.addAdmin("mock:sys_admin");
  const sysEvent = {unifiedUserId: "mock:sys_admin", sender: {id: "sys_admin"}};

  // 列表查看
  let out = await dispatch("!AI管理员列表", {unifiedUserId: "mock:ai_user1"});
  assert.equal(out.status, "HANDLED");
  assert.match(out.reply, /【AI 管理员列表】共 2 人/);
  assert.match(out.reply, /mock:ai_user1/);
  assert.match(out.reply, /mock:ai_user2/);

  // 普通 AI 管理员尝试删除另一个 AI 管理员 -> DENIED（仅系统管理员可执行）
  out = await dispatch("!AI管理员删除 mock:ai_user2", {unifiedUserId: "mock:ai_user1"});
  assert.equal(out.status, "DENIED");
  assert.match(out.reply, /只有系统管理员可以删除 AI 管理员/);

  // 系统管理员尝试删除系统管理员 -> 被拒
  out = await dispatch("!AI管理员删除 mock:sys_admin", sysEvent);
  assert.match(out.reply, /不能删除系统管理员/);

  // 系统管理员删除不存在的 ID -> 提示未找到
  out = await dispatch("!AI管理员删除 mock:non_exist", sysEvent);
  assert.match(out.reply, /未找到 AI 管理员/);

  // 系统管理员成功删除 mock:ai_user2
  out = await dispatch("!AI管理员删除 mock:ai_user2", sysEvent);
  assert.match(out.reply, /已删除 AI 管理员 mock:ai_user2/);
  assert.match(out.reply, /剩余 1 人/);

  // 被删除后 mock:ai_user2 权限丢失
  out = await dispatch("!帮助", {unifiedUserId: "mock:ai_user2"});
  assert.equal(out.status, "DENIED");

  // 删空后，系统管理员依然可以使用指令，不报错
  await dispatch("!AI管理员删除 mock:ai_user1", sysEvent);
  out = await dispatch("!AI管理员列表", sysEvent);
  assert.match(out.reply, /目前没有独立的 AI 管理员/);
  out = await dispatch("!帮助", sysEvent);
  assert.equal(out.status, "HANDLED");
});
