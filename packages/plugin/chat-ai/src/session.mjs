/**
 * @file packages/plugin/chat-ai/src/session.mjs
 * @description 会话键、策略解析、敏感过滤、文本裁剪等纯函数与小工具。
 *              本文件不访问数据库、不发网络请求，便于单测。
 */

/** 入站敏感模式：凭据、授权链接与 CQ 码一律不进入上下文。 */
const SENSITIVE_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|ltoken(_v2)?=|stoken(_v2)?=|cookie_token(_v2)?=|authkey(_ver)?=|login_ticket=|Cookie:|\[CQ:/i;
/** 控制字符（保留 \t \n \r 之外的 C0/C1 与 DEL）。 */
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** CQ 码段：含未闭合的 `[CQ:`（模型输出与用户输入都可能带）。 */
const CQ_PATTERN = /\[CQ:[^\]]*\]?/g;

/**
 * 会话键：`platform:botId:scope:scopeId`；群聊缺 groupId、私聊缺 unifiedUserId 时返回 null。
 * @param {Object} event 入站事件信封（只读取 platform/botId/isGroup/groupId/unifiedUserId）
 * @returns {string|null}
 */
export function sessionKeyOf(event) {
  if (!event || typeof event !== "object") return null;
  const platform = String(event.platform ?? "").trim();
  if (!platform) return null;
  const botId = event.botId === undefined || event.botId === null || String(event.botId) === "" ? "-" : String(event.botId);
  if (event.isGroup) {
    const groupId = event.groupId === undefined || event.groupId === null ? "" : String(event.groupId).trim();
    return groupId ? platform + ":" + botId + ":group:" + groupId : null;
  }
  const userId = String(event.unifiedUserId ?? "").trim();
  return userId ? platform + ":" + botId + ":private:" + userId : null;
}

/**
 * 会话作用域数据（交给 store.ensureSession）。
 * @param {Object} event 入站事件信封
 * @returns {{sessionId:string, platform:string, botId:string|null, scope:'private'|'group', scopeId:string}|null}
 */
export function sessionDataOf(event) {
  const sessionId = sessionKeyOf(event);
  if (!sessionId) return null;
  const isGroup = Boolean(event.isGroup);
  return {
    sessionId,
    platform: String(event.platform ?? ""),
    botId: event.botId === undefined || event.botId === null || String(event.botId) === "" ? null : String(event.botId),
    scope: isGroup ? "group" : "private",
    scopeId: isGroup ? String(event.groupId) : String(event.unifiedUserId)
  };
}

/**
 * 有效策略：会话显式策略优先，否则按作用域取全局默认。
 * 无法判定作用域（session 为空）时按 off 处理（fail-closed），避免误回群聊。
 * @param {{policy?:string|null, scope?:string}|null} session
 * @param {{policy:{groupDefault:string, privateDefault:string}}} config
 * @returns {'off'|'mention'|'all'}
 */
export function resolvePolicy(session, config) {
  const stored = session?.policy;
  if (stored === "off" || stored === "mention" || stored === "all") return stored;
  if (!session) return "off";
  if(["off","mention","all"].includes(session.defaultPolicy))return session.defaultPolicy;
  const defaults = config?.policy || {};
  const fallback = session.scope === "group" ? defaults.groupDefault : defaults.privateDefault;
  return fallback === "off" || fallback === "mention" || fallback === "all" ? fallback : "off";
}

/**
 * 入站敏感文本判定：命中凭据、授权链接或 CQ 码。
 * @param {unknown} text
 * @returns {boolean}
 */
export function isSensitiveText(text) {
  return typeof text === "string" && SENSITIVE_PATTERN.test(text);
}

/**
 * 裁剪入站/出站文本：剥离 CQ 段与控制字符、去首尾空白、按字符数截断（不劈开代理对）。
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function clipText(text, max = 1000) {
  if (typeof text !== "string") return "";
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.trunc(Number(max)) : 1000;
  const cleaned = text.replace(CQ_PATTERN, "").replace(CONTROL_PATTERN, "").trim();
  const chars = Array.from(cleaned);
  return chars.length > limit ? chars.slice(0, limit).join("").trim() : cleaned;
}

/**
 * 每日额度键（本地时区 YYYY-MM-DD）；测试可注入 now。
 * @param {number|Date} [now]
 * @returns {string}
 */
export function dayKey(now = Date.now()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return "1970-01-01";
  const pad = value => String(value).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

/**
 * 取插件服务（store/config）；未装配时抛出可脱敏的业务错误。
 * @param {Object} ctx
 * @returns {{store:Object, config:Object}}
 */
export function servicesOf(ctx) {
  const services = ctx?.services || {};
  if (!services.store || !services.config) {
    throw Object.assign(new Error("chat-ai services are not assembled"), {code: "CHATAI_SERVICES", publicMessage: "聊天 AI 服务尚未装配，本次指令未执行。"});
  }
  return services;
}
