/**
 * @file packages/provider-mihoyo/src/signer.mjs
 * @description 米哈游 Takumi DS1 / DS2 动态签名计算器
 */

import crypto from "node:crypto";

// 2.71.1 基线盐值
export const SALTS = {
  // 战绩查询/便签 (DS1)
  RECORD_DS1: "xV8vVuOBqIOB00nugrIZug1xxBLOuWKK",
  // 社区发帖/鉴权/签到 (DS2 / K2)
  COMMUNITY_DS2: "t0qEgfub6cvueAPgR5mMgQFtmaJuoUZ6"
};

/**
 * 计算 DS1 签名 (用于 api-takumi-record 战绩与便签查询)
 * @param {string} [query=""] - 规范化的 URL query 字符串 (如 role_id=17708598&server=prod_gf_cn)
 * @param {string} [body=""] - 请求体字符串
 * @param {string} [salt=SALTS.RECORD_DS1] - 盐值
 * @returns {string} 格式为 `${t},${r},${hash}`
 */
export function getDs1(query = "", body = "", salt = SALTS.RECORD_DS1) {
  const t = Math.floor(Date.now() / 1000);
  const r = Math.random().toString(36).substring(2, 8); // 6位随机串
  const content = `salt=${salt}&t=${t}&r=${r}&b=${body}&q=${query}`;
  const hash = crypto.createHash("md5").update(content).digest("hex");
  return `${t},${r},${hash}`;
}

/**
 * 计算 DS2 签名 (用于通行证与社区互动)
 * @param {string} [query=""]
 * @param {string} [body=""]
 * @param {string} [salt=SALTS.COMMUNITY_DS2]
 * @returns {string}
 */
export function getDs2(query = "", body = "", salt = SALTS.COMMUNITY_DS2) {
  const t = Math.floor(Date.now() / 1000);
  const r = Math.floor(Math.random() * 100000 + 100000); // 100000~200000
  const content = `salt=${salt}&t=${t}&r=${r}&b=${body}&q=${query}`;
  const hash = crypto.createHash("md5").update(content).digest("hex");
  return `${t},${r},${hash}`;
}
