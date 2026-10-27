/**
 * @file packages/plugin/chat-ai/src/handlers/chat.mjs
 * @description 基础指令：帮助、状态、显式对话。不含密钥与正文。
 */

import {clipText, dayKey, isSensitiveText, resolvePolicy, servicesOf, sessionDataOf} from "../session.mjs";

/** 帮助只列已实现的指令；未实现的 P2/P3 能力不得出现在命令表里。 */
const HELP_SECTIONS = Object.freeze([
  {
    title: "基础与对话",
    items: [
      {routeId: "help", args: [], desc: "查看指令帮助与权限说明"},
      {routeId: "status", args: [], desc: "查看会话状态、健康检查与额度"},
      {routeId: "say", args: ["<内容>"], desc: "显式触发一次对话（同义词见动态帮助）"}
    ]
  },
  {
    title: "模型档案管理",
    items: [
      {routeId: "modelAdd", args: [], desc: "分步向导新增模型档案"},
      {routeId: "modelSet", args: ["<别名>"], desc: "分步修改模型档案（可跳过）"},
      {routeId: "modelRemove", args: ["<别名>"], desc: "删除指定模型档案"},
      {routeId: "modelList", args: [], desc: "列出已配置模型档案与状态"},
      {routeId: "modelCheck", args: ["[别名]"], desc: "现场探测模型可用性"}
    ]
  },
  {
    title: "人物卡管理",
    items: [
      {routeId: "characterImport", args: [], desc: "开启文件或文本人物卡导入（仅限私聊）"},
      {routeId: "characterList", args: [], desc: "列出已导入人物卡"},
      {routeId: "characterUse", args: ["<人物ID>"], desc: "绑定人物卡到当前会话"},
      {routeId: "characterOff", args: [], desc: "卸下当前会话人物卡"}
    ]
  },
  {
    title: "会话策略与上下文",
    items: [
      {routeId: "policySet", args: ["<off|mention|all>"], desc: "设置会话回复策略"},
      {routeId: "contextShow", args: [], desc: "查看当前会话上下文消息条数"},
      {routeId: "contextClear", args: [], desc: "清空上下文并递增会话代号"}
    ]
  },
  {
    title: "管理员认证与维护",
    items: [
      {routeId: "aiAuth", args: ["<token>"], desc: "认证成为 AI 管理员（仅限私聊）"},
      {routeId: "aiAdminList", args: [], desc: "查看当前 AI 管理员列表"},
      {routeId: "aiAdminRemove", args: ["<unifiedUserId>"], desc: "删除 AI 管理员（仅系统管理员）"}
    ]
  }
]);

const clockOf = services => (typeof services?.now === "function" ? services.now() : Date.now());
const usage = (ctx, routeId, args) => "用法: " + ctx.commands.format({routeId, args});

/**
 * 帮助：
 * 1. 一行插件说明 + 当前前缀；
 * 2. 分组的命令表：命令 | 参数 | 说明；
 * 3. 权限说明；
 * 4. 未实现项一句带过。
 * @param {Object} ctx
 */
export async function help(ctx) {
  const lines = [
    "【聊天 AI 指令手册】当前前缀见命令示例：",
    ""
  ];
  for (const section of HELP_SECTIONS) {
    lines.push("· " + section.title);
    for (const item of section.items) {
      lines.push("  " + ctx.commands.format({routeId: item.routeId, args: item.args}) + " - " + item.desc);
    }
  }
  lines.push("");
  lines.push("【权限说明】本插件所有指令仅限聊天 AI 管理员；系统管理员默认拥有全部权限；AI 管理员请私聊发送 " + ctx.commands.format({routeId: "aiAuth", args: ["<token>"]}) + " 认证。");
  const extra=[
    ["设置与模型",[["settings",[]],["connectionAdd",[]],["connectionList",[]],["connectionInfo",["<连接ID>"]],["connectionEdit",["<连接ID>"]],["connectionDelete",["<连接ID>"]],["connectionDiscover",["<连接ID>"]],["connectionModelAdd",["<连接ID>"]],["modelUse",["<名称或ID>"]],["defaultModel",["<名称或ID>"]],["modelInfo",[]],["modelRename",["<ID>","<显示名称>"]],["modelOptions",["<ID>","<温度|输出|超时|上下文>","<值>"]]]],
    ["人物维护",[["characterPreview",["<ID>","[页]"]],["characterEdit",["<ID>"]],["characterExport",["<ID>"]],["characterDelete",["<ID>"]],["characterOverwrite",["<ID>"]]]],
    ["回复与记忆",[["retry",[]],["cancel",[]],["memorySet",["<on|off>"]],["memoryAdd",["<内容>"]],["memoryList",[]],["memoryDelete",["<编号>"]],["summarize",[]],["summaryClear",[]]]],
    ["可选行为",[["eventSet",["<on|off 或 类型 off|template|persona>"]],["stickerAdd",["<ID>","<名称>"]],["stickerPreview",["<ID>"]],["stickerReplace",["<ID>"]],["stickerTags",["<ID>","<标签,标签>","<人物ID或*>"]],["stickerImport",[]],["stickerList",[]],["stickerDelete",["<ID>"]],["stickerSet",["<on|off>"]],["proactiveSet",["<分钟，0关闭>"]],["proactiveStatus",[]]]]
  ];
  for(const [title,rows] of extra) {lines.push("· "+title);for(const [routeId,args] of rows)lines.push("  "+ctx.commands.format({routeId,args}));}
  lines.push("事件、表情、主动发言和长期记忆注入默认关闭。生成摘要会消耗一次模型调用。人物卡由管理员自行导入。");
  await ctx.event.reply(lines.join("\n"));
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
