/**
 * @file tools/import-gacha.mjs
 * @description 存量抽卡记录 JSON 显式手动导入工具
 * 严格按照审查意见：放弃自动数据库迁移，仅提供干净、安全的独立手动导入工具。
 * 兼容标准 UIGF 结构以及纯抽卡数组结构，使用 ON CONFLICT DO UPDATE 实现安全幂等重跑。
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/**
 * 确保抽卡表结构存在
 * @param {DatabaseSync} db
 */
export function ensureGachaTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gacha_records (
        id              TEXT PRIMARY KEY,
        uid             TEXT NOT NULL,
        gacha_type      TEXT NOT NULL,
        item_type       TEXT,
        name            TEXT NOT NULL,
        rank_type       INTEGER NOT NULL,
        time            DATETIME NOT NULL,
        item_id         TEXT,
        imported_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_gacha_uid_time ON gacha_records(uid, gacha_type, time);
  `);
}

/**
 * 导入抽卡记录 JSON 文件到数据库
 * @param {string} filePath - JSON 文件路径
 * @param {DatabaseSync | string} dbOrPath - 数据库实例或数据库路径
 * @returns {{ total: number, insertedOrUpdated: number, sRanks: number, aRanks: number, uid: string }}
 */
export function importGachaJson(filePath, dbOrPath = "./data/vault.db") {
  if (!fs.existsSync(filePath)) {
    throw new Error(`找不到抽卡记录文件: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`无法解析 JSON 文件: ${err.message}`);
  }

  // 提取抽卡列表与默认 UID
  let rawList = [];
  let defaultUid = "";

  if (Array.isArray(parsed)) {
    rawList = parsed;
    defaultUid = parsed[0]?.uid ? String(parsed[0].uid) : "";
  } else if (parsed && typeof parsed === "object") {
    defaultUid = parsed.info?.uid ? String(parsed.info.uid) : "";
    if (Array.isArray(parsed.list)) {
      rawList = parsed.list;
    } else if (Array.isArray(parsed.data)) {
      rawList = parsed.data;
    } else {
      // 兼容绝区零插件原生多频段卡池结构：{ "独家频段": [...], "音擎频段": [...], ... }
      for (const val of Object.values(parsed)) {
        if (Array.isArray(val)) {
          for (const item of val) {
            rawList.push(item);
            if (!defaultUid && item?.uid) {
              defaultUid = String(item.uid);
            }
          }
        }
      }
    }
  }

  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw new Error("抽卡记录文件中未包含有效的抽卡记录条目 (list 为空)");
  }

  let db;
  if (typeof dbOrPath === "string") {
    const dir = path.dirname(dbOrPath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new DatabaseSync(dbOrPath);
  } else {
    db = dbOrPath;
  }
  ensureGachaTable(db);

  const stmt = db.prepare(`
    INSERT INTO gacha_records (id, uid, gacha_type, item_type, name, rank_type, time, item_id, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      uid = excluded.uid,
      gacha_type = excluded.gacha_type,
      item_type = excluded.item_type,
      name = excluded.name,
      rank_type = excluded.rank_type,
      time = excluded.time,
      item_id = excluded.item_id,
      imported_at = CURRENT_TIMESTAMP
  `);

  let sRanks = 0;
  let aRanks = 0;
  let count = 0;

  db.exec("BEGIN TRANSACTION;");
  try {
    for (const item of rawList) {
      const id = String(item.id || item.record_id || `gacha-${item.time}-${count}`);
      const uid = String(item.uid || defaultUid || "0");
      const gachaType = String(item.gacha_type || item.pool_type || "1");
      const itemType = String(item.item_type || item.type || "");
      const name = String(item.name || item.item_name || "未知物品");
      const rankType = Number(item.rank_type || item.rarity || 2);
      const time = String(item.time || item.datetime || new Date().toISOString());
      const itemId = item.item_id ? String(item.item_id) : null;

      // 绝区零/米哈游: S 级/5星对应 rank_type 4 或 5, A 级对应 3 或 4
      if (rankType >= 4) {
        sRanks++;
      } else if (rankType === 3) {
        aRanks++;
      }

      stmt.run(id, uid, gachaType, itemType, name, rankType, time, itemId);
      count++;
    }
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }

  return {
    total: rawList.length,
    insertedOrUpdated: count,
    sRanks,
    aRanks,
    uid: defaultUid
  };
}

// CLI 执行入口
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const filePath = process.argv[2];
  const dbPath = process.argv[3] || "./data/vault.db";

  if (!filePath) {
    console.log("使用方式: node tools/import-gacha.mjs <抽卡记录JSON路径> [数据库路径]");
    process.exit(1);
  }

  try {
    const stats = importGachaJson(filePath, dbPath);
    console.log(`=== 抽卡记录手动导入成功 ===`);
    console.log(`• 目标 UID: ${stats.uid || "未知"}`);
    console.log(`• 成功导入记录: ${stats.insertedOrUpdated} 条`);
    console.log(`• 包含 S 级 (S-Rank): ${stats.sRanks} 个`);
    console.log(`• 包含 A 级 (A-Rank): ${stats.aRanks} 个`);
  } catch (err) {
    console.error(`导入失败: ${err.message}`);
    process.exit(1);
  }
}
