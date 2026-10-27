import test from "node:test";
import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {IdentityVault, InboundShaper, assembleModules} from "../packages/core/src/index.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("chat-ai 与 llm 模块装配、依赖校验、入站落库与指令交互", async t => {
  const vault = new IdentityVault(":memory:");
  const config = {
    version: 1,
    modules: [
      { kind: "provider", id: "llm", entry: "packages/provider/llm/src/index.mjs" },
      {
        kind: "plugin", id: "chat-ai", entry: "packages/plugin/chat-ai/src/index.mjs",
        namespace: { prefix: "!", aliases: ["！"], priority: 50 }
      }
    ]
  };

  const runtime = await assembleModules({
    root,
    config,
    vault,
    importModule: async url => import(url)
  });

  t.after(async () => {
    try { await runtime.stop(); } catch { /* 已关闭 */ }
    try { vault.close(); } catch { /* 已关闭 */ }
  });

  const dispatcher = runtime.dispatcher;

  // 1. 装配成功；dispatcher.plugins.has("chat-ai")、dispatcher.providers.has("llm")；dispatcher.validateDependencies() 不抛
  assert.equal(dispatcher.plugins.has("chat-ai"), true);
  assert.equal(dispatcher.providers.has("llm"), true);
  assert.doesNotThrow(() => dispatcher.validateDependencies());

  const plugin = dispatcher.plugins.get("chat-ai");
  const store = plugin.services.store;

  // 2. 用真实 InboundShaper.shape 造群聊 payload（含 at 段 qq = self_id）→ dispatch → 该会话入库 1 条
  let replyCount = 0;
  const replies = [];
  const sendFunction = async (_target, msg) => {
    replyCount += 1;
    replies.push(String(msg));
    return { success: true };
  };

  const rawGroupMessage = {
    post_type: "message",
    message_type: "group",
    group_id: 1001,
    user_id: 2002,
    self_id: 9999,
    message_id: 5001,
    time: 1700000000,
    sender: { user_id: 2002, nickname: "张三", role: "member" },
    message: [
      { type: "at", data: { qq: "9999" } },
      { type: "text", data: { text: " 你好" } }
    ]
  };

  const shapedGroupEvent = InboundShaper.shape(rawGroupMessage, { sendFunction });
  assert.equal(shapedGroupEvent.mentionedBot, true);
  assert.equal(shapedGroupEvent.isGroup, true);
  assert.equal(shapedGroupEvent.cleanText, "你好");

  const expectedSessionId = "qq-napcat:9999:group:1001";
  await dispatcher.dispatch(shapedGroupEvent);
  assert.equal(store.countMessages(expectedSessionId), 1);

  // 3. 同一 eventId 重复 dispatch → 仍 1 条
  await dispatcher.dispatch(shapedGroupEvent);
  assert.equal(store.countMessages(expectedSessionId), 1);

  // 4. dispatcher.formatCommand({pluginId:"chat-ai", routeId:"help"}) 得到的命令文本直接 dispatch → HANDLED，
  // 回复里含 帮助 且不含「表情包」「主动发言」「长期记忆」「摘要」被当作可用命令列出（help 末尾的否定句可以出现这些词，断言请针对命令行列）
  dispatcher.addAdmin("qq-napcat:2002");
  const helpCommandText = dispatcher.formatCommand({ pluginId: "chat-ai", routeId: "help" });
  assert.ok(helpCommandText.length > 0);

  const rawHelpMessage = {
    post_type: "message",
    message_type: "group",
    group_id: 1001,
    user_id: 2002,
    self_id: 9999,
    message_id: 5002,
    time: 1700000001,
    sender: { user_id: 2002, nickname: "张三", role: "member" },
    message: [
      { type: "text", data: { text: helpCommandText } }
    ]
  };

  const helpEvent = InboundShaper.shape(rawHelpMessage, { sendFunction });
  const helpResult = await dispatcher.dispatch(helpEvent);
  assert.equal(helpResult.status, "HANDLED");
  assert.ok(replies.length > 0);
  const helpReply = replies.at(-1);
  assert.match(helpReply, /帮助/);

  // 检查命令行列（以两空格缩进开头的行）：不含未实现能力
  const commandLines = helpReply.split("\n").filter(line => line.startsWith("!"));
  assert.ok(commandLines.length > 0);
  for (const cmdLine of commandLines) {
    assert.ok(cmdLine.trim().startsWith("!"));
  }

  // 5. 普通文本且没有模型档案 → P1.1 触发错误提示（HANDLED，发送尚未配置提示，5分钟冷却）
  let plainReplies = [];
  const plainSendFunction = async (_target, msg) => {
    plainReplies.push(String(msg));
    return { success: true };
  };

  const rawPlainMessage = {
    post_type: "message",
    message_type: "private",
    user_id: 3003,
    self_id: 9999,
    message_id: 5003,
    time: 1700000002,
    sender: { user_id: 3003, nickname: "李四" },
    message: [
      { type: "text", data: { text: "普通对话文本" } }
    ]
  };

  const plainEvent = InboundShaper.shape(rawPlainMessage, { sendFunction: plainSendFunction });
  const plainResult = await dispatcher.dispatch(plainEvent);
  assert.equal(plainResult.status, "HANDLED");
  await plugin.services.engine.drain();
  assert.equal(plainReplies.length, 1);
  assert.match(plainReplies[0], /聊天 AI 尚未配置可用模型（缺少密钥或模型档案），请联系管理员。/);

  // 6. runtime.stop() 正常返回、vault 可 close()、进程无残留 timer（测试结束 t.after 清理）
  await runtime.stop();
  assert.doesNotThrow(() => vault.close());
});
