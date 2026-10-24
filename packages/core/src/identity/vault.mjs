/**
 * @file packages/core/src/identity/vault.mjs
 * @description 基于原生 node:sqlite 的统一身份保密库 (Identity Vault)
 * 严格解决 P0-01 (ON CONFLICT DO UPDATE 杜绝级联误删) 与 P1-06 (用户/游戏维度的唯一定向激活角色)
 */

import { DatabaseSync } from "node:sqlite";

export class IdentityVault {
  /**
   * @param {string} [dbPath=":memory:"] - 数据库存储路径或内存标记
   */
  constructor(dbPath = ":memory:") {
    this.db = new DatabaseSync(dbPath);
    // 强制开启外键完整性约束
    this.db.exec("PRAGMA foreign_keys = ON;");
    this._initTables();
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

      -- 索引优化
      CREATE INDEX IF NOT EXISTS idx_game_roles_account ON game_roles(provider_id, account_key);
      CREATE INDEX IF NOT EXISTS idx_bindings_user ON user_community_bindings(unified_user_id);
    `);
  }

  /**
   * 保存或更新通行证凭据 (使用 ON CONFLICT DO UPDATE，彻底杜绝 REPLACE 先删后插导致的 ON DELETE CASCADE 误删关系)
   */
  saveCredential(providerId, accountKey, cookies, deviceMeta = {}) {
    const cookiesJson = typeof cookies === "string" ? cookies : JSON.stringify(cookies);
    const deviceJson = typeof deviceMeta === "string" ? deviceMeta : JSON.stringify(deviceMeta);

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
    this.db.exec("BEGIN TRANSACTION;");
    try {
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

      this.db.exec("COMMIT;");
      return true;
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
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
      WHERE b.unified_user_id = ? AND r.game_id = ? AND r.is_active = 1
      LIMIT 1
    `);
    const row = stmt.get(unifiedUserId, gameId);
    if (!row) return null;

    let cookies = {};
    let device = {};
    try { cookies = JSON.parse(row.cookies_json); } catch {}
    try { device = JSON.parse(row.device_meta); } catch {}

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
        r.uid, r.region, r.nickname, r.level, r.is_active,
        r.provider_id, r.account_key
      FROM user_community_bindings b
      JOIN game_roles r ON b.provider_id = r.provider_id AND b.account_key = r.account_key
      WHERE b.unified_user_id = ? AND r.game_id = ?
      ORDER BY r.is_active DESC, r.level DESC
    `);
    return stmt.all(unifiedUserId, gameId);
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
