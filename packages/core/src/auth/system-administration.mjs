import crypto from "node:crypto";
import { logger } from "../logger/logger.mjs";

const SETTING = "system:admin_users";
const USER_ID = /^[a-z][a-z0-9-]*:[^\s:\x00-\x1f\x7f]{1,128}$/;

export const isQualifiedUserId = value => typeof value === "string" && value === value.trim() && USER_ID.test(value);

function configuredUsers(value) {
  if (value === undefined || value === "") return [];
  if (typeof value !== "string") throw new Error("GAMEHUB_ADMIN_USERS 必须是完整平台用户ID的列表。");
  const users = value.split(/[,，;]/).map(id => id.trim()).filter(Boolean);
  if (users.some(id => !isQualifiedUserId(id))) throw new Error("GAMEHUB_ADMIN_USERS 仅接受平台:用户ID格式，请迁移旧的裸ID配置。");
  return users;
}

/** Core-owned configuration. No channel or connection-token fallback is allowed. */
export function resolveSystemAdministration({ env = process.env, adminToken, adminUsers = [] } = {}) {
  return {
    registrationToken: adminToken ?? env.GAMEHUB_ADMIN_REGISTRATION_TOKEN ?? "",
    configuredAdminUsers: configuredUsers(env.GAMEHUB_ADMIN_USERS),
    adminUsers
  };
}

/** Authorizes platform-qualified people; transport authentication stays in channels. */
export class SystemAdministration {
  #tokenDigest;
  #configuredUsers;
  #vault;

  constructor({ vault = null, registrationToken = "", configuredAdminUsers = [], adminUsers = [] } = {}) {
    if (typeof registrationToken !== "string" || /\s/.test(registrationToken)) {
      throw new Error("GAMEHUB_ADMIN_REGISTRATION_TOKEN 必须是不含空白的字符串；留空关闭注册。");
    }
    for (const users of [configuredAdminUsers, adminUsers]) {
      if (!Array.isArray(users) || users.some(id => !isQualifiedUserId(id))) throw new Error("系统管理员配置仅接受完整的平台:用户ID。");
    }
    this.#vault = vault;
    this.#tokenDigest = registrationToken ? this.#digest(registrationToken) : null;
    this.#configuredUsers = new Set(configuredAdminUsers);
    this.adminUsers = new Set(adminUsers);
    const persisted = vault?.getSetting(SETTING, []) ?? [];
    if (!Array.isArray(persisted)) throw new Error("系统管理员名单存储格式无效，请检查备份。");
    let ignored = 0;
    for (const id of persisted) {
      if (isQualifiedUserId(id)) this.adminUsers.add(id);
      else ignored++;
    }
    if (ignored) logger.warn("SystemAuth", `已停用 ${ignored} 条旧裸ID或无效管理员身份；请重新私聊认证或使用完整平台用户ID授权。原存储未改写。`);
  }

  #digest(token) { return crypto.createHash("sha256").update(token).digest(); }
  get registrationEnabled() { return this.#tokenDigest !== null; }

  #identity(event) {
    const id = event?.unifiedUserId;
    if (!isQualifiedUserId(id)) return null;
    const separator = id.indexOf(":");
    if (event.platform !== undefined && event.platform !== id.slice(0, separator)) return null;
    if (event.sender?.id !== undefined && String(event.sender.id) !== id.slice(separator + 1)) return null;
    return id;
  }

  isConfigured(id) { return this.#configuredUsers.has(id); }
  isAdmin(event) {
    const id = this.#identity(event);
    return id !== null && (this.#configuredUsers.has(id) || this.adminUsers.has(id));
  }

  list() {
    const ids = new Set([...this.#configuredUsers, ...this.adminUsers]);
    return [...ids].filter(isQualifiedUserId).sort().map(id => ({ id, source: this.isConfigured(id) ? "configuration" : "registered" }));
  }

  #save(next) {
    try { this.#vault?.setSetting(SETTING, [...next]); }
    catch {
      const error = new Error("系统管理员名单保存失败，本次权限变更未生效。");
      error.code = "ADMIN_STORE_FAILED";
      error.publicMessage = error.message;
      throw error;
    }
    this.adminUsers.clear();
    for (const id of next) this.adminUsers.add(id);
  }

  addAdmin(id) {
    if (!isQualifiedUserId(id)) return false;
    if (this.isConfigured(id) || this.adminUsers.has(id)) return true;
    this.#save(new Set([...this.adminUsers].filter(isQualifiedUserId)).add(id));
    return true;
  }

  removeAdmin(id) {
    if (!isQualifiedUserId(id) || this.isConfigured(id) || !this.adminUsers.has(id)) return false;
    const next = new Set([...this.adminUsers].filter(isQualifiedUserId));
    next.delete(id);
    this.#save(next);
    return true;
  }

  register(event, token) {
    if (event?.isGroup) return { success: false, code: "PRIVATE_ONLY" };
    if (!this.registrationEnabled) return { success: false, code: "REGISTRATION_DISABLED" };
    const id = this.#identity(event);
    if (!id || !event.platform || event.sender?.id === undefined) return { success: false, code: "INVALID_IDENTITY" };
    if (typeof token !== "string" || !crypto.timingSafeEqual(this.#digest(token), this.#tokenDigest)) return { success: false, code: "INVALID_TOKEN" };
    const alreadyRegistered = this.isAdmin(event);
    this.addAdmin(id);
    return { success: true, alreadyRegistered };
  }
}
