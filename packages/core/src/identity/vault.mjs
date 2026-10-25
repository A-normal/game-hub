/**
 * @file packages/core/src/identity/vault.mjs
 * @description 基于原生 node:sqlite 的统一身份保密库 (Identity Vault)
 * 严格解决 P0-01 (ON CONFLICT DO UPDATE 杜绝级联误删) 与 P1-06 (用户/游戏维度的唯一定向激活角色)
 */

import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

export class IdentityVault {
  /**
   * @param {string} [dbPath=":memory:"] - 数据库存储路径或内存标记
   */
  constructor(dbPath = ":memory:", { readOnly = false } = {}) {
    this.db = new DatabaseSync(dbPath, { readOnly });
    this._transactionId = 0;
    this._secretKey = null;
    // 强制开启外键完整性约束
    this.db.exec("PRAGMA foreign_keys = ON;");
    if (!readOnly) this._initTables();
  }

  _getSecretKey() {
    if (!this._secretKey) {
      const secret = process.env.VAULT_SECRET || "gamehub-identity-vault-salt-key-2026";
      this._secretKey = crypto.createHash("sha256").update(secret).digest();
    }
    return this._secretKey;
  }

  _encryptCredential(plainText) {
    if (!plainText) return plainText;
    const key = this._getSecretKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return "enc:v1:" + Buffer.concat([iv, tag, encrypted]).toString("base64");
  }

  _decryptCredential(cipherText) {
    if (!cipherText || typeof cipherText !== "string") return cipherText;
    if (!cipherText.startsWith("enc:v1:")) return cipherText;
    try {
      const buf = Buffer.from(cipherText.slice(7), "base64");
      if (buf.length < 28) throw new Error("Invalid encrypted envelope");
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const data = buf.subarray(28);
      const key = this._getSecretKey();
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return decipher.update(data, undefined, "utf8") + decipher.final("utf8");
    } catch {
      throw Object.assign(new Error("Credential decryption failed"), {
        code: "VAULT_DECRYPT",
        publicMessage: "账号凭据解密失败，请管理员核对 VAULT_SECRET 与数据库备份；本次未发送社区请求。"
      });
    }
  }

  _initTables() {
    this.db.exec(`
      -- 1. 聊天平台用户主体表
      CREATE TABLE IF NOT EXISTS chat_users (
          unified_user_id TEXT PRIMARY KEY,
          platform        TEXT NOT NULL,
          original_id     TEXT NOT NULL,
          created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- 2. 社区通行证凭据表 (米游社/库街区等，与聊天平台解耦)
      CREATE TABLE IF NOT EXISTS community_credentials (
          provider_id     TEXT NOT NULL,
          account_key     TEXT NOT NULL,
          cookies_json    TEXT NOT NULL,
          device_meta     TEXT NOT NULL,
          updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (provider_id, account_key)
      );

      -- 3. 用户-社区通行证多对多绑定表
      CREATE TABLE IF NOT EXISTS user_community_bindings (
          unified_user_id TEXT NOT NULL,
          provider_id     TEXT NOT NULL,
          account_key     TEXT NOT NULL,
          bound_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (unified_user_id, provider_id, account_key),
          FOREIGN KEY (unified_user_id) REFERENCES chat_users(unified_user_id) ON DELETE CASCADE,
          FOREIGN KEY (provider_id, account_key) REFERENCES community_credentials(provider_id, account_key) ON DELETE CASCADE
      );

      -- 4. 游戏角色实体表
      CREATE TABLE IF NOT EXISTS game_roles (
          provider_id     TEXT NOT NULL,
          account_key     TEXT NOT NULL,
          game_id         TEXT NOT NULL,
          uid             TEXT NOT NULL,
          region          TEXT NOT NULL,
          nickname        TEXT NOT NULL,
          level           INTEGER DEFAULT 0,
          is_active       INTEGER DEFAULT 0, -- 1为当前选中的主角色，0为备选
          updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (game_id, uid),
          FOREIGN KEY (provider_id, account_key) REFERENCES community_credentials(provider_id, account_key) ON DELETE CASCADE
      );

      -- 5. 系统与插件配置持久化表 (解决总线指令式动态改名与启停)
      CREATE TABLE IF NOT EXISTS system_settings (
          setting_key   TEXT PRIMARY KEY,
          setting_value TEXT NOT NULL,
          updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS user_active_roles (
        unified_user_id TEXT NOT NULL REFERENCES chat_users(unified_user_id) ON DELETE CASCADE,
        game_id TEXT NOT NULL,
        uid TEXT NOT NULL,
        PRIMARY KEY (unified_user_id, game_id),
        FOREIGN KEY (game_id, uid) REFERENCES game_roles(game_id, uid) ON DELETE CASCADE
      );
      INSERT OR IGNORE INTO user_active_roles (unified_user_id, game_id, uid)
      SELECT unified_user_id, game_id, uid FROM (
        SELECT b.unified_user_id, r.game_id, r.uid,
          ROW_NUMBER() OVER (PARTITION BY b.unified_user_id, r.game_id ORDER BY r.is_active DESC, r.level DESC, r.uid) AS preference
        FROM user_community_bindings b JOIN game_roles r
          ON r.provider_id = b.provider_id AND r.account_key = b.account_key
      ) WHERE preference = 1;

      -- 索引优化
      CREATE INDEX IF NOT EXISTS idx_game_roles_account ON game_roles(provider_id, account_key);
      CREATE INDEX IF NOT EXISTS idx_bindings_user ON user_community_bindings(unified_user_id);
    `);
  }

  /**
   * 保存或更新通行证凭据 (使用 ON CONFLICT DO UPDATE，彻底杜绝 REPLACE 先删后插导致的 ON DELETE CASCADE 误删关系)
   */
  saveCredential(providerId, accountKey, cookies, deviceMeta = {}) {
    const rawCookiesJson = JSON.stringify(typeof cookies === "string" ? { ck: cookies } : cookies);
    const cookiesJson = this._encryptCredential(rawCookiesJson);
    const deviceJson = this._encryptCredential(typeof deviceMeta === "string" ? deviceMeta : JSON.stringify(deviceMeta));

    const stmt = this.db.prepare(`
      INSERT INTO community_credentials (provider_id, account_key, cookies_json, device_meta, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(provider_id, account_key) DO UPDATE SET
        cookies_json = excluded.cookies_json,
        device_meta = excluded.device_meta,
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(providerId, accountKey.toString(), cookiesJson, deviceJson);
  }

  /**
   * 确保聊天用户存在并绑定社区账号
   */
  bindUser(unifiedUserId, platform, originalId, providerId, accountKey) {
    if (!unifiedUserId || !platform || originalId === undefined || originalId === null || String(originalId).trim() === "") {
      throw new Error("聊天用户身份不完整，无法绑定账号");
    }
    const userStmt = this.db.prepare(`
      INSERT INTO chat_users (unified_user_id, platform, original_id)
      VALUES (?, ?, ?)
      ON CONFLICT(unified_user_id) DO NOTHING
    `);
    userStmt.run(unifiedUserId, platform, originalId.toString());

    const bindStmt = this.db.prepare(`
      INSERT INTO user_community_bindings (unified_user_id, provider_id, account_key)
      VALUES (?, ?, ?)
      ON CONFLICT(unified_user_id, provider_id, account_key) DO NOTHING
    `);
    bindStmt.run(unifiedUserId, providerId, accountKey.toString());
  }

  /**
   * 同步、可嵌套的事务边界，避免扫码绑定失败后只保存了部分数据。
   */
  _transaction(action) {
    const name = `vault_tx_${++this._transactionId}`;
    this.db.exec(`SAVEPOINT ${name};`);
    try {
      const result = action();
      this.db.exec(`RELEASE SAVEPOINT ${name};`);
      return result;
    } catch (err) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`);
      throw err;
    }
  }

  /**
   * 原子保存一次经过验证的登录结果。不根据残留凭据猜测聊天用户归属。
   * @param {Object} binding
   * @returns {import('../types.mjs').SelectedRole | null}
   */
  saveAccountBinding({ unifiedUserId, platform, originalId, providerId, accountKey, gameId, cookies, device = {}, roles = [], activeUid }) {
    if (!providerId || !accountKey || !gameId || !Array.isArray(roles)) {
      throw new Error("账号绑定数据不完整");
    }
    return this._transaction(() => {
      this.saveCredential(providerId, accountKey, cookies, device);
      this.bindUser(unifiedUserId, platform, originalId, providerId, accountKey);
      for (const role of roles) {
        const owner = this.db.prepare("SELECT provider_id, account_key FROM game_roles WHERE game_id = ? AND uid = ?").get(gameId, String(role.uid));
        if (owner && (owner.provider_id !== providerId || owner.account_key !== String(accountKey))) {
          throw new Error("游戏角色归属与当前通行证不一致");
        }
      }
      this.saveRoles(providerId, accountKey, gameId, roles);
      if (activeUid && !this.setActiveRole(unifiedUserId, gameId, activeUid)) {
        throw new Error("无法激活本次登录的游戏角色");
      }
      return this.getActiveRole(unifiedUserId, gameId);
    });
  }

  /**
   * 保存游戏角色列表，并自动处理默认激活逻辑
   * @param {string} providerId
   * @param {string} accountKey
   * @param {string} gameId
   * @param {Array<{ uid: string, region: string, nickname: string, level?: number }>} roles
   */
  saveRoles(providerId, accountKey, gameId, roles) {
    if (!Array.isArray(roles) || roles.length === 0) return;

    const roleStmt = this.db.prepare(`
      INSERT INTO game_roles (provider_id, account_key, game_id, uid, region, nickname, level, is_active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
      ON CONFLICT(game_id, uid) DO UPDATE SET
        region = excluded.region,
        nickname = excluded.nickname,
        level = excluded.level,
        updated_at = CURRENT_TIMESTAMP
    `);

    for (const r of roles) {
      roleStmt.run(
        providerId,
        accountKey.toString(),
        gameId,
        r.uid.toString(),
        r.region || "prod_gf_cn",
        r.nickname || "",
        Number(r.level || 0)
      );
    }

    // 检查该账号在此游戏下是否已经有激活的角色，若没有，默认将第一个设置为激活状态
    const checkStmt = this.db.prepare(`
      SELECT uid FROM game_roles 
      WHERE provider_id = ? AND account_key = ? AND game_id = ? AND is_active = 1
      LIMIT 1
    `);
    const active = checkStmt.get(providerId, accountKey.toString(), gameId);
    if (!active && roles[0]) {
      const activateStmt = this.db.prepare(`
        UPDATE game_roles SET is_active = 1 WHERE game_id = ? AND uid = ?
      `);
      activateStmt.run(gameId, roles[0].uid.toString());
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO user_active_roles (unified_user_id, game_id, uid)
      SELECT unified_user_id, ?, ? FROM user_community_bindings
      WHERE provider_id = ? AND account_key = ?
    `).run(gameId, String(roles[0].uid), providerId, String(accountKey));
  }

  /**
   * 保存单个游戏角色
   */
  saveGameRole(providerId, accountKey, gameId, uid, region, nickname, level = 0, isActive = 0) {
    this.saveRoles(providerId, accountKey, gameId, [{
      uid: String(uid),
      region: region || "prod_gf_cn",
      nickname: nickname || "绳匠",
      level: Number(level || 0)
    }]);

    if (isActive) {
      this.db.prepare("UPDATE game_roles SET is_active = 1 WHERE game_id = ? AND uid = ?").run(gameId, String(uid));
    }
  }

  /**
   * 切换用户在指定游戏下的激活角色（确保唯一激活约束）
   * @param {string} unifiedUserId
   * @param {string} gameId
   * @param {string} targetUid
   * @returns {boolean} 是否切换成功
   */
  setActiveRole(unifiedUserId, gameId, targetUid) {
    // 1. 验证该角色是否归属于该用户
    const checkStmt = this.db.prepare(`
      SELECT r.uid
      FROM user_community_bindings b
      JOIN game_roles r ON b.provider_id = r.provider_id AND b.account_key = r.account_key
      WHERE b.unified_user_id = ? AND r.game_id = ? AND r.uid = ?
      LIMIT 1
    `);
    const found = checkStmt.get(unifiedUserId, gameId, targetUid.toString());
    if (!found) {
      return false;
    }

    // 2. 事务更新：取消此用户在当前游戏下的所有激活角色，再将指定角色激活
    return this._transaction(() => {
      this.db.prepare(`
        INSERT INTO user_active_roles (unified_user_id, game_id, uid) VALUES (?, ?, ?)
        ON CONFLICT(unified_user_id, game_id) DO UPDATE SET uid = excluded.uid
      `).run(unifiedUserId, gameId, String(targetUid));
      this.db.prepare(`
        UPDATE game_roles 
        SET is_active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE game_id = ? AND (provider_id, account_key) IN (
          SELECT provider_id, account_key FROM user_community_bindings WHERE unified_user_id = ?
        )
      `).run(gameId, unifiedUserId);

      this.db.prepare(`
        UPDATE game_roles 
        SET is_active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE game_id = ? AND uid = ?
      `).run(gameId, targetUid.toString());

      return true;
    });
  }

  /**
   * 获取用户在指定游戏下的当前激活角色及凭据
   * @param {string} unifiedUserId
   * @param {string} gameId
   * @returns {import('../types.mjs').SelectedRole | null}
   */
  getActiveRole(unifiedUserId, gameId) {
    const stmt = this.db.prepare(`
      SELECT 
        r.uid, r.region, r.nickname, r.level, r.game_id,
        r.provider_id, r.account_key,
        c.cookies_json, c.device_meta
      FROM user_community_bindings b
      JOIN game_roles r ON b.provider_id = r.provider_id AND b.account_key = r.account_key
      JOIN community_credentials c ON b.provider_id = c.provider_id AND b.account_key = c.account_key
      JOIN user_active_roles a ON a.unified_user_id = b.unified_user_id AND a.game_id = r.game_id AND a.uid = r.uid
      WHERE b.unified_user_id = ? AND r.game_id = ?
      LIMIT 1
    `);
    const row = stmt.get(unifiedUserId, gameId);
    if (!row) return null;

    let cookies = {};
    let device = {};
    const decryptedJson = this._decryptCredential(row.cookies_json);
    try {
      const parsed = JSON.parse(decryptedJson);
      cookies = typeof parsed === "string" ? { ck: parsed } : (parsed || {});
    } catch {
      // 兼容旧扫码代码写入的裸 Cookie；只在读取时适配，不批量改写已有数据。
      if (decryptedJson && decryptedJson.includes("=")) cookies = { ck: decryptedJson };
    }
    const decryptedDevice = this._decryptCredential(row.device_meta);
    try { device = JSON.parse(decryptedDevice); } catch {}

    return {
      uid: row.uid,
      region: row.region,
      nickname: row.nickname,
      level: row.level,
      gameId: row.game_id,
      providerId: row.provider_id,
      accountKey: row.account_key,
      cookies,
      device
    };
  }

  /**
   * 查询用户在某游戏下的所有绑定角色列表
   */
  getUserRoles(unifiedUserId, gameId) {
    const stmt = this.db.prepare(`
      SELECT 
        r.uid, r.region, r.nickname, r.level, CASE WHEN a.uid = r.uid THEN 1 ELSE 0 END AS is_active,
        r.provider_id, r.account_key
      FROM user_community_bindings b
      JOIN game_roles r ON b.provider_id = r.provider_id AND b.account_key = r.account_key
      LEFT JOIN user_active_roles a ON a.unified_user_id = b.unified_user_id AND a.game_id = r.game_id
      WHERE b.unified_user_id = ? AND r.game_id = ?
      ORDER BY (CASE WHEN a.uid = r.uid THEN 1 ELSE 0 END) DESC, r.level DESC, r.uid ASC
    `);
    return stmt.all(unifiedUserId, gameId);
  }

  unbindUser(userId, providerId, accountKey) {
    return this._transaction(() => {
      this.db.prepare("DELETE FROM user_community_bindings WHERE unified_user_id=? AND provider_id=? AND account_key=?").run(userId,providerId,String(accountKey));
      this.db.prepare(`DELETE FROM user_active_roles WHERE unified_user_id=? AND NOT EXISTS (
        SELECT 1 FROM game_roles r JOIN user_community_bindings b ON b.provider_id=r.provider_id AND b.account_key=r.account_key
        WHERE b.unified_user_id=? AND r.game_id=user_active_roles.game_id AND r.uid=user_active_roles.uid
      )`).run(userId,userId);
      const games = this.db.prepare("SELECT DISTINCT game_id FROM game_roles").all();
      for (const {game_id} of games) if (!this.getActiveRole(userId,game_id)) {
        const next = this.getUserRoles(userId,game_id)[0]; if (next) this.setActiveRole(userId,game_id,next.uid);
      }
      this.db.prepare("DELETE FROM community_credentials WHERE provider_id=? AND account_key=? AND NOT EXISTS (SELECT 1 FROM user_community_bindings WHERE provider_id=? AND account_key=?)").run(providerId,String(accountKey),providerId,String(accountKey));
    });
  }

  getUserCredential(userId, providerId, accountKey) {
    const row=this.db.prepare(`SELECT c.cookies_json,c.device_meta FROM community_credentials c JOIN user_community_bindings b
      ON c.provider_id=b.provider_id AND c.account_key=b.account_key WHERE b.unified_user_id=? AND c.provider_id=? AND c.account_key=?`).get(userId,providerId,String(accountKey));
    if (!row) return null;
    let cookies,device={};
    const decryptedJson = this._decryptCredential(row.cookies_json);
    try { cookies=JSON.parse(decryptedJson); } catch { cookies={ck:decryptedJson}; }
    if (typeof cookies==="string") cookies={ck:cookies};
    const decryptedDevice=this._decryptCredential(row.device_meta);
    try {device=JSON.parse(decryptedDevice);} catch {}
    return {cookies,device};
  }

  /**
   * 保存系统配置项
   * @param {string} key
   * @param {any} value
   */
  setSetting(key, value) {
    const valStr = typeof value === "string" ? value : JSON.stringify(value);
    const stmt = this.db.prepare(`
      INSERT INTO system_settings (setting_key, setting_value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(key, valStr);
  }

  /**
   * 读取系统配置项
   * @param {string} key
   * @param {any} [defaultValue=null]
   */
  getSetting(key, defaultValue = null) {
    const stmt = this.db.prepare("SELECT setting_value FROM system_settings WHERE setting_key = ?");
    const row = stmt.get(key);
    if (!row) return defaultValue;
    try {
      return JSON.parse(row.setting_value);
    } catch {
      return row.setting_value;
    }
  }

  /**
   * 获取所有以特定前缀开头的配置键值
   * @param {string} [prefix=""]
   * @returns {Record<string, any>}
   */
  getAllSettings(prefix = "") {
    const stmt = this.db.prepare("SELECT setting_key, setting_value FROM system_settings WHERE setting_key LIKE ?");
    const rows = stmt.all(`${prefix}%`);
    const result = {};
    for (const r of rows) {
      try {
        result[r.setting_key] = JSON.parse(r.setting_value);
      } catch {
        result[r.setting_key] = r.setting_value;
      }
    }
    return result;
  }

  /**
   * 外键约束检查（用于自动化测试与审计）
   */
  foreignKeyCheck() {
    return this.db.prepare("PRAGMA foreign_key_check;").all();
  }

  close() {
    this.db.close();
  }
}

export default IdentityVault;
