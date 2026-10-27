/**
 * @file packages/plugin/chat-ai/src/admin.mjs
 * @description 双管理员判定与管理指令：系统管理员与 AI 管理员认证、列表与删除。
 *              存储走 vault.setSetting("chat-ai:admins", [...]) / getSetting。
 */

import crypto from "node:crypto";
import {cancelInput} from "./input.mjs";

/** 按 vault 实例分桶的 AI 管理员缓存（WeakMap：不同库/不同进程实例互不污染）。 */
let adminCache = new WeakMap();

/**
 * 失效缓存：传 vault 只清该库，不传则整体重建（测试与停用时使用）。
 * @param {Object} [vault]
 */
export function invalidateAiAdminsCache(vault) {
  if (vault && typeof vault === "object") adminCache.delete(vault);
  else adminCache = new WeakMap();
}

/**
 * 读取 AI 管理员列表（按 vault 缓存）。
 * @param {Object} vault
 * @returns {string[]}
 */
export function getAiAdmins(vault) {
  if (!vault || typeof vault.getSetting !== "function") return [];
  const hit = adminCache.get(vault);
  if (hit) return hit;
  const val = vault.getSetting("chat-ai:admins", []);
  const list = Array.isArray(val) ? val.map(String) : [];
  adminCache.set(vault, list);
  return list;
}

/**
 * 写入 AI 管理员列表并同步缓存。
 * @param {Object} vault
 * @param {string[]} admins
 */
export function setAiAdmins(vault, admins) {
  const unique = Array.from(new Set((Array.isArray(admins) ? admins : []).map(String)));
  if (vault && typeof vault.setSetting === "function") {
    vault.setSetting("chat-ai:admins", unique);
    adminCache.set(vault, unique);
  }
  return unique;
}

/**
 * 新增 AI 管理员（去重）。
 * @param {Object} vault
 * @param {string} unifiedUserId
 * @returns {number} 当前管理员数量
 */
export function addAiAdmin(vault, unifiedUserId) {
  const id = String(unifiedUserId ?? "").trim();
  if (!id) return getAiAdmins(vault).length;
  const list = getAiAdmins(vault);
  if (!list.includes(id)) {
    const next = [...list, id];
    setAiAdmins(vault, next);
    return next.length;
  }
  return list.length;
}

/**
 * 删除指定 AI 管理员。
 * @param {Object} vault
 * @param {string} unifiedUserId
 * @returns {boolean} 是否成功删除
 */
export function removeAiAdmin(vault, unifiedUserId) {
  const id = String(unifiedUserId ?? "").trim();
  const list = getAiAdmins(vault);
  if (!list.includes(id)) return false;
  const next = list.filter(item => item !== id);
  setAiAdmins(vault, next);
  return true;
}

/**
 * 判断是否为系统管理员（总线管理员）。
 * @param {Object} event
 * @param {Object} [dispatcher]
 * @returns {boolean}
 */
export function isSystemAdmin(event, dispatcher) {
  try {
    return typeof dispatcher?.isAdmin === "function" && dispatcher.isAdmin(event) === true;
  } catch {
    return false;
  }
}

/**
 * 统一双管理员判断：系统管理员隐式拥有权限 || AI 管理员列表包含该用户。
 * @param {Object} event
 * @param {{vault?:Object, dispatcher?:Object}} [options]
 * @returns {boolean}
 */
export function hasChatAdmin(event, {vault, dispatcher} = {}) {
  if (isSystemAdmin(event, dispatcher)) return true;
  const userId = event?.unifiedUserId ? String(event.unifiedUserId) : "";
  if (!userId) return false;
  const admins = getAiAdmins(vault);
  return admins.includes(userId);
}

/**
 * 管理员权限拦截包装：非 AI 管理员直接拒绝并返回 DENIED。
 * @param {Function} action
 * @returns {Function}
 */
export function withAdmin(action) {
  return async function adminGatedAction(ctx) {
    if (!hasChatAdmin(ctx?.event, {vault: ctx?.vault, dispatcher: ctx?.dispatcher})) {
      const authCmd = ctx?.commands?.format ? ctx.commands.format({routeId: "aiAuth", args: ["<密钥>"]}) : "!AI认证 <密钥>";
      await ctx?.event?.reply?.("【权限拒绝】该指令仅限聊天 AI 管理员。系统管理员默认拥有权限；普通用户请私聊发送 " + authCmd + " 进行认证。");
      return {status: "DENIED"};
    }
    cancelInput(ctx.services,ctx.event);
    return action(ctx);
  };
}

/**
 * !AI认证 <token>：仅私聊，timingSafeEqual 比较 CHATAI_ADMIN_TOKEN。
 * 成功后把 unifiedUserId 加入 AI 管理员列表。
 * @param {Object} ctx
 */
export async function aiAuth(ctx) {
  const event = ctx?.event;
  if (event?.isGroup) {
    await event.reply("【权限拒绝】AI 管理员认证仅支持私聊发起。");
    return {status: "DENIED"};
  }
  const expectedToken = process.env.CHATAI_ADMIN_TOKEN;
  if (typeof expectedToken !== "string" || !expectedToken.trim()) {
    await event?.reply?.("未配置 AI 管理员密钥（CHATAI_ADMIN_TOKEN），请联系系统管理员。");
    return {status: "DENIED"};
  }
  const input = String((ctx?.args || [])[0] || "");
  const supplied = Buffer.from(input);
  const expected = Buffer.from(expectedToken.trim());
  if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    await event?.reply?.("AI 管理员认证失败：密钥错误！");
    return {status: "DENIED"};
  }
  const unifiedUserId = String(event?.unifiedUserId || "");
  if (!unifiedUserId) {
    await event?.reply?.("无法确定当前用户身份。");
    return {status: "DENIED"};
  }
  const count = addAiAdmin(ctx.vault, unifiedUserId);
  await event?.reply?.("【AI 管理员认证成功】当前 AI 管理员共 " + count + " 人。");
  return {status: "HANDLED"};
}

/**
 * !AI管理员列表：列出 AI 管理员并标注是否同时为系统管理员，不显示 token。
 * @param {Object} ctx
 */
export async function aiAdminList(ctx) {
  const admins = getAiAdmins(ctx?.vault);
  if (!admins.length) {
    await ctx?.event?.reply?.("目前没有独立的 AI 管理员（系统管理员默认拥有全部权限）。");
    return;
  }
  const lines = ["【AI 管理员列表】共 " + admins.length + " 人："];
  for (const userId of admins) {
    const fakeEvent = {unifiedUserId: userId, sender: {id: userId.split(":").at(-1) || userId}};
    const isSys = isSystemAdmin(fakeEvent, ctx?.dispatcher);
    lines.push("· " + userId + (isSys ? " (系统管理员)" : ""));
  }
  await ctx?.event?.reply?.(lines.join("\n"));
}

/**
 * !AI管理员删除 <unifiedUserId>：仅系统管理员可执行，不能删系统管理员。
 * @param {Object} ctx
 */
export async function aiAdminRemove(ctx) {
  if (!isSystemAdmin(ctx?.event, ctx?.dispatcher)) {
    await ctx?.event?.reply?.("【权限拒绝】只有系统管理员可以删除 AI 管理员。");
    return {status: "DENIED"};
  }
  const targetId = String((ctx?.args || [])[0] || "").trim();
  if (!targetId) {
    const usageStr = ctx?.commands?.format ? ctx.commands.format({routeId: "aiAdminRemove", args: ["<unifiedUserId>"]}) : "!AI管理员删除 <unifiedUserId>";
    await ctx?.event?.reply?.("用法: " + usageStr);
    return;
  }
  const fakeEvent = {unifiedUserId: targetId, sender: {id: targetId.split(":").at(-1) || targetId}};
  if (isSystemAdmin(fakeEvent, ctx?.dispatcher)) {
    await ctx?.event?.reply?.("不能删除系统管理员（系统管理员权限不可撤销且不受 AI 管理员列表影响）。");
    return;
  }
  const admins = getAiAdmins(ctx?.vault);
  if (!admins.includes(targetId)) {
    await ctx?.event?.reply?.("未找到 AI 管理员 " + targetId + "。");
    return;
  }
  removeAiAdmin(ctx.vault, targetId);
  const remaining = getAiAdmins(ctx.vault).length;
  await ctx?.event?.reply?.("已删除 AI 管理员 " + targetId + "。当前剩余 " + remaining + " 人。");
}

export default {
  getAiAdmins,
  setAiAdmins,
  addAiAdmin,
  removeAiAdmin,
  isSystemAdmin,
  hasChatAdmin,
  withAdmin,
  aiAuth,
  aiAdminList,
  aiAdminRemove,
  invalidateAiAdminsCache
};
