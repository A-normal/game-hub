import {CHAT_COMMAND_HELP} from "./command-help.mjs";
/**
 * @file packages/plugin/chat-ai/src/manifest.mjs
 * @description chat-ai 路由表。默认命名空间为 !（别名 ！）。
 *              所有命令指令均经 withAdmin 鉴权包装，除 !AI认证 之外普通用户全部 DENIED。
 */

import {
  aiAdminList,
  aiAdminRemove,
  aiAuth,
  withAdmin
} from "./admin.mjs";
import {
  characterPreview, characterExport, characterDelete, characterOverwrite,
  characterImport,
  characterList,
  characterOff,
  characterUse,
  contextClear,
  contextShow,
  policySet
} from "./handlers/admin.mjs";
import * as catalog from "./catalog.mjs";
import * as features from "./features.mjs";
import * as assets from "./assets.mjs";
import {interjectionSet,interjectionStatus,interjectionSettings,isReplyToBot,tryInterjection} from "./interjection.mjs";
import {consumeInput} from "./input.mjs";
import {help, say, status} from "./handlers/chat.mjs";
import {clipText, dayKey, isSensitiveText, resolvePolicy, sessionDataOf} from "./session.mjs";
import {
  handleWizardInput,
  isWizardEvent,
  modelCheck,
  modelRemove,
  modelSet
} from "./wizard.mjs";

const clockOf = services => (typeof services?.now === "function" ? services.now() : Date.now());

/**
 * 观察器：text 之后、fallback 之前执行，只做同步落库 + 裁剪。
 * 不回复、不发网络请求、不 await 定时器；返回值被 dispatcher 忽略。
 * 命令路由与未知命令在到达本阶段前就已返回，因此这里天然拿不到指令消息。
 * @param {Object} ctx
 */
function observe(ctx) {
  const services = ctx?.services;
  if (!services?.store || !services?.config) return;
  const event = ctx.event;
  services.intake ||= new WeakMap();
  services.intake.set(event, {accepted:false});
  const data = sessionDataOf(event);
  if (!data) return;
  const senderId = event.sender?.id === undefined || event.sender?.id === null ? "" : String(event.sender.id);
  // 机器人自身消息不入库，避免自问自答。
  if (data.botId && senderId === data.botId) return;
  const raw = typeof event.cleanText === "string" ? event.cleanText : "";
  if (!raw.trim() || isSensitiveText(raw)) return;
  const text = clipText(raw, services.config.retention.maxCharsPerMessage);
  if (!text || isSensitiveText(text)) return;
  const store = services.store;
  // 策略 off 同时停止记录与回复；回复侧的同一判定在 replyAction 里。
  const session = store.ensureSession(data);
  if (resolvePolicy(session, services.config) === "off") return;
  if (!store.claimEvent(data.sessionId, event.eventId)) return;
  const inserted = store.insertMessage({
    sessionId: data.sessionId,
    eventId: event.eventId === undefined || event.eventId === null ? null : String(event.eventId),
    messageId:event.messageId || null,
    role: "user",
    senderId: event.unifiedUserId ? String(event.unifiedUserId) : null,
    senderName: clipText(event.sender?.name, 40) || null,
    context:{replyTo:clipText(event.replyMessage?.id,100),mentions:(event.mentions || []).slice(0,20).map(item=>clipText(String(item.id),100))},
    text
  });
  // 同一 event_id 重复到达时不重复计数，也不触发额外裁剪。
  if (inserted) store.pruneMessages(data.sessionId, services.config.retention.maxMessages);
  services.intake.set(event, {accepted:inserted});
}

/**
 * 兜底回复：触发判定全部在 action 内完成。
 * 若未配置可用模型或配置错误，入队后由引擎向用户发送友好提示（5 分钟冷却），不静默丢弃。
 * @param {Object} ctx
 * @returns {boolean}
 */
function replyAction(ctx) {
  try {
    const services = ctx?.services;
    const event = ctx?.event;
    if (!services?.store || !services?.config || !services?.engine || !event) return false;
    if (typeof event.reply !== "function") return false;
    const data = sessionDataOf(event);
    if (!data) return false;
    const {store, config, engine} = services;
    const session = store.ensureSession(data);
    const policy = resolvePolicy(session, config);
    if (policy === "off") return false;
    const text = clipText(event.cleanText, config.retention.maxCharsPerMessage);
    if (!text || isSensitiveText(event.cleanText) || event.sender?.id === event.botId || services.intake?.get(event)?.accepted === false) return false;
    if(policy === "mention" && event.mentionedBot !== true) {
      if(!interjectionSettings(store,data.sessionId).enabled || !isReplyToBot(store,data.sessionId,event))return tryInterjection(ctx,session);
    }
    const usage = store.getUsage(data.sessionId, dayKey(clockOf(services)));
    if ((usage?.requests ?? 0) >= config.limits.requestsPerDay) return false;
    return engine.enqueue({
      sessionId: data.sessionId,
      epoch: session.epoch,
      text,
      trigger: "auto",
      userName:event.sender?.name,
      reply: event.reply,
      isGroup: Boolean(event.isGroup)
    }) === true;
  } catch {
    return false;
  }
}

export const manifest = {
  id: "chat-ai",
  kind: "plugin",
  contractVersion: 1,
  name: "聊天 AI",
  defaultNamespace: {prefix: "!", aliases: ["！"], priority: 50},
  providers: [{id: "llm", capabilities: ["chat"]}],
  routes: [
    {id: "help", tokens: ["帮助"], action: withAdmin(help)},
    {id: "status", tokens: ["状态"], action: withAdmin(status)},
    {id: "say", tokens: ["对话"], action: withAdmin(say)},

    {id: "modelAdd", tokens: ["模型新增"], action: withAdmin(catalog.modelAdd)},
    {id: "modelSet", tokens: ["模型修改"], action: withAdmin(modelSet)},
    {id: "modelRemove", tokens: ["模型删除"], action: withAdmin(modelRemove)},
    {id: "modelList", tokens: ["模型列表"], action: withAdmin(catalog.modelList)},
    {id: "modelCheck", tokens: ["模型检测"], action: withAdmin(modelCheck)},

    {id:"characterPreview",tokens:["人物预览"],action:withAdmin(characterPreview)},
    {id:"characterExport",tokens:["人物导出"],action:withAdmin(characterExport)},
    {id:"characterDelete",tokens:["人物删除"],action:withAdmin(characterDelete)},
    {id:"characterOverwrite",tokens:["人物覆盖"],action:withAdmin(characterOverwrite)},
    {id: "characterList", tokens: ["人物列表"], action: withAdmin(characterList)},
    {id: "characterImport", tokens: ["人物导入"], action: withAdmin(characterImport)},
    {id: "characterUse", tokens: ["人物切换"], action: withAdmin(characterUse)},
    {id: "characterOff", tokens: ["人物卸下"], action: withAdmin(characterOff)},

    {id: "policySet", tokens: ["策略设置"], action: withAdmin(policySet)},
    {id: "contextShow", tokens: ["上下文"], action: withAdmin(contextShow)},
    {id: "contextClear", tokens: ["清空上下文"], action: withAdmin(contextClear)},

    // 认证指令排除在 withAdmin 之外，允许任何人在私聊中发起认证
    {id: "aiAuth", tokens: ["AI认证"], action: aiAuth},
    {id: "aiAdminList", tokens: ["AI管理员列表"], action: withAdmin(aiAdminList)},
    {id: "aiAdminRemove", tokens: ["AI管理员删除"], action: withAdmin(aiAdminRemove)},

    ...[
      ["settings","设置",catalog.settings], ["connectionAdd","连接新增",catalog.connectionAdd],
      ["connectionList","连接列表",catalog.connectionList], ["connectionInfo","连接详情",catalog.connectionInfo],
      ["connectionEdit","连接修改",catalog.connectionEdit], ["connectionDelete","连接删除",catalog.connectionDelete],
      ["connectionDiscover","发现模型",catalog.connectionDiscover],
      ["modelUse","模型切换",catalog.useModel], ["defaultModel","默认模型",catalog.defaultModel],
      ["modelOptions","模型参数",catalog.modelOptions], ["modelInfo","模型详情",catalog.modelInfo], ["modelRename","模型命名",catalog.modelRename],
      ["retry","重试",catalog.retry], ["cancel","取消回复",catalog.cancel], ["characterEdit","人物编辑",catalog.characterEdit],
      ["memorySet","记忆设置",features.memorySet], ["memoryAdd","记忆添加",features.memoryAdd],
      ["memoryList","记忆列表",features.memoryList], ["memoryDelete","记忆删除",features.memoryDelete],
      ["summarize","生成摘要",features.summarize], ["summaryClear","删除摘要",features.summaryClear],
      ["eventSet","事件设置",features.eventSet], ["stickerAdd","表情添加",features.stickerAdd],
      ["eventStatus","事件状态",features.eventStatus],
      ["interjectionSet","插话设置",interjectionSet], ["interjectionStatus","插话状态",interjectionStatus],
      ["stickerList","表情列表",features.stickerList], ["stickerDelete","表情删除",features.stickerDelete],
      ["stickerSet","表情设置",features.stickerSet], ["proactiveSet","主动设置",features.proactiveSet],
      ["stickerReplace","表情替换",assets.stickerReplace],["stickerTags","表情标签",assets.stickerTags],
      ["stickerPreview","表情预览",assets.stickerPreview],["stickerImport","表情导入",assets.stickerImport],
      ["proactiveStatus","主动状态",features.proactiveStatus]
    ].map(([id,token,handler])=>({id,tokens:[token],action:withAdmin(handler)})),
    {id:"fileInput",stage:"event",action:consumeInput},
    {id:"eventResponse",stage:"event",action:features.eventResponse},
    // 内部路由：向导输入（stage: text 阶段完全消费）、观察器与兜底回复
    {id:"fileInputText",stage:"text",action:consumeInput},
    {id: "wizard", stage: "text", match: event => isWizardEvent(event), action: handleWizardInput},
    {id:"catalogInput",stage:"text",match:catalog.isCatalogInput,action:catalog.catalogInput},
    {id: "observe", stage: "observer", action: observe},
    {id: "reply", stage: "fallback", action: replyAction}
  ].map(route => CHAT_COMMAND_HELP[route.id] ? {...route, argumentSeparator: true, description: CHAT_COMMAND_HELP[route.id].description, help: CHAT_COMMAND_HELP[route.id]} : route)
};

export default manifest;
