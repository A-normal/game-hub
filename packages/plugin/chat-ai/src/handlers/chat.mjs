/**
 * @file packages/plugin/chat-ai/src/handlers/chat.mjs
 * @description 基础指令：帮助、状态、显式对话。不含密钥与正文。
 */

import {clipText, dayKey, isSensitiveText, resolvePolicy, servicesOf, sessionDataOf} from "../session.mjs";

const clockOf = services => (typeof services?.now === "function" ? services.now() : Date.now());
const usage = (ctx, routeId, args) => "用法: " + ctx.commands.format({routeId, args});

export async function help(ctx) {
  return ctx.commands.help({
    title: "聊天 AI 指令手册",
    common: ["settings", "status", "say", "connectionAdd", "modelAdd", "modelList", "modelUse", "characterImport", "characterList", "characterUse", "policySet", "contextClear"],
    note: "所有管理指令需 AI 管理权限；系统管理员默认拥有权限。事件、表情、主动问候和记忆注入默认关闭。"
  });
}

/**
 * 状态：显示会话键、策略、人物、默认档案、健康检查结论、额度与待回复。
 * @param {Object} ctx
 */
export async function status(ctx) {
  const services = servicesOf(ctx);
  const {store, config} = services;
  const event = ctx.event;
  const data = sessionDataOf(event);
  if (!data) {
    await event.reply("无法确定当前会话。");
    return;
  }
  const session = store.ensureSession(data);
  const used = store.getUsage(data.sessionId, dayKey(clockOf(services)))?.requests ?? 0;
  const pending = typeof services.engine?.pending === "function" ? services.engine.pending(data.sessionId) : 0;
  const defaultProfile = (store.getSetting("defaultModel") ?? (services.health?.defaultProfileId || config.model.defaultProfileId)) || "无";
  const boundProfile = session.modelProfileId || defaultProfile;

  const lines = [
    "【聊天 AI 状态】",
    "会话: " + data.sessionId,
    "作用域: " + (data.scope === "group" ? "群聊" : "私聊"),
    "策略: " + resolvePolicy(session, config),
    "人物: " + (session.characterId || "未绑定"),
    "默认档案: " + defaultProfile,
    "当前模型名称: " + (store.getModel(boundProfile)?.label || boundProfile),
    "模型档案: " + store.listModels().length + " 个（本会话: " + boundProfile + "）",
    "上下文窗口: " + config.retention.maxMessages + " 条 / 单条 " + config.retention.maxCharsPerMessage + " 字",
    "额度: " + used + "/" + config.limits.requestsPerDay,
    "待回复: " + pending,
    "调试: " + (config.debug ? "开" : "关"),
    "【启动健康检查】（启动自动选取；管理员切换立即生效）"
  ];

  const profiles = services.health?.profiles || [];
  if (profiles.length) {
    for (const p of profiles) {
      lines.push("· " + p.id + ": " + p.status + (p.reason ? " (" + p.reason + ")" : ""));
    }
  } else {
    lines.push("· 暂无检查记录");
  }

  const lastErr = typeof services.engine?.lastErrorCode === "function" ? services.engine.lastErrorCode(data.sessionId) : null;
  const generation=store.getSetting("generation:"+boundProfile);
  if(generation)lines.push("最近生成: "+generation.code+(generation.status?" HTTP "+generation.status:""));
  if (lastErr) {
    lines.push("最近错误码: " + lastErr);
  }

  lines.push("帮助: " + ctx.commands.format({routeId: "help"}));
  await event.reply(lines.join("\n"));
}

/**
 * 显式对话：敏感过滤、额度、插入 user 行并入队。
 * @param {Object} ctx
 */
export async function say(ctx) {
  const services = servicesOf(ctx);
  const {store, config, engine} = services;
  const event = ctx.event;
  const data = sessionDataOf(event);
  if (!data) {
    await event.reply("无法确定当前会话。");
    return;
  }
  const raw = String(ctx.argumentText || "").trim();
  if (!raw) {
    await event.reply(usage(ctx, "say", ["<内容>"]));
    return;
  }
  const used = store.getUsage(data.sessionId, dayKey(clockOf(services)))?.requests ?? 0;
  if (isSensitiveText(raw)) {
    await event.reply("该内容包含敏感信息，已拒绝处理（既不入库也不发给模型）。");
    return;
  }
  if (used >= config.limits.requestsPerDay) {
    await event.reply("今日额度已用完（上限 " + config.limits.requestsPerDay + " 次），请明天再试。");
    return;
  }
  const text = clipText(raw, config.retention.maxCharsPerMessage);
  if (!text) {
    await event.reply(usage(ctx, "say", ["<内容>"]));
    return;
  }
  const session = store.ensureSession(data);
  if (!store.claimEvent(data.sessionId, event.eventId)) return;
  store.insertMessage({
    sessionId: data.sessionId,
    eventId: event.eventId === undefined || event.eventId === null ? null : String(event.eventId),
    role: "user",
    senderId: event.unifiedUserId ? String(event.unifiedUserId) : null,
    senderName: clipText(event.sender?.name, 40) || null,
    text
  });
  store.pruneMessages(data.sessionId, config.retention.maxMessages);
  if (!engine || typeof engine.enqueue !== "function") {
    await event.reply("AI 暂时不可用，请稍后再试。");
    return;
  }
  const accepted = engine.enqueue({
    sessionId: data.sessionId,
    epoch: session.epoch,
    text,
    trigger: "explicit",
    userName:event.sender?.name,
    reply: event.reply,
    isGroup: Boolean(event.isGroup)
  });
  if (!accepted) await event.reply("回复队列已满，请稍后再试。");
}

export default {help, status, say};
