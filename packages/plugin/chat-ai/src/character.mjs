/**
 * @file packages/plugin/chat-ai/src/character.mjs
 * @description 文本人物卡与 Character Card JSON 常用字段解析；存储上限独立于模型上下文预算。
 */

import crypto from "node:crypto";

/** 常用字段；只限制显示名称，其余正文在总大小上限内完整保存。 */
export const CHARACTER_FIELDS = Object.freeze([
  ["name", 60],
  ["description", 4000],
  ["personality", 2000],
  ["scenario", 2000],
  ["first_mes", 1000],
  ["mes_example", 4000],
  ["system_prompt", 2000],
  ["post_history_instructions", 2000]
]);

/** 总输入上限。实际注入模型时另按模型上下文预算裁剪。 */
export const MAX_CARD_BYTES = 1024 * 1024;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

const cardError = message => Object.assign(new Error(message), {code: "CHATAI_BAD_CARD", publicMessage: message});

const charCount = text => Array.from(text).length;
const takeChars = (text, limit) => (charCount(text) > limit ? Array.from(text).slice(0, limit).join("") : text);

/**
 * 稳定人物 id：name 去掉非法字符后取前 32 字符；为空时用 `char-` + sha256(name+owner) 前 8 位。
 * @param {{name?:string}} card
 * @param {string} [owner]
 * @returns {string}
 */
export function characterIdFor(card, owner = "") {
  const name = String(card?.name ?? "");
  const normalized = name
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim()
    .slice(0, 32);
  if (normalized) return normalized;
  return "char-" + crypto.createHash("sha256").update(name + String(owner ?? "")).digest("hex").slice(0, 8);
}

/**
 * 解析人物卡：支持 `{spec:"chara_card_v2", data:{...}}` 与扁平对象（也接受 JSON 字符串）。
 * TXT/Markdown 全文作为 description 保存；JSON 常用字段完整保存，未知字段提示忽略。
 * @param {Object|string} raw
 * @param {{owner?:string}} [options]
 * @returns {{id:string, card:Object, warnings:string[]}}
 */
export function parseCharacterCard(raw, {owner = "", filename = "", format = "auto"} = {}) {
  if (raw === undefined || raw === null) throw cardError("人物卡内容为空。");
  const source = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (!source || !source.trim()) throw cardError("人物卡内容为空。");
  if (Buffer.byteLength(source, "utf8") > MAX_CARD_BYTES) throw cardError("人物卡超过 1 MiB 上限。");

  let parsed;
  if (typeof raw === "string") {
    const text=raw.replace(/^\uFEFF/,"");
    const plain=()=>{
      const heading=/^\s*#*\s*(?:角色卡[：:]\s*)?([^\r\n—–]+)(?:[—–]|$)/m.exec(text)?.[1]?.trim();
      return {name:heading || filename.replace(/\.[^.]+$/,"") || "未命名人物",description:text};
    };
    if(format==="text")parsed=plain();
    else if(/^[\s]*[\[{]/.test(text) || /\.json$/i.test(filename)) {
      try { parsed = JSON.parse(text); } catch {
        if(/\.(txt|md|markdown)$/i.test(filename))parsed=plain();else throw cardError("人物卡不是合法 JSON。");
      }
    } else parsed=plain();
  } else parsed = raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw cardError("人物卡必须是 JSON 对象。");

  const nested = ["chara_card_v2","chara_card_v3"].includes(parsed.spec) && parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data);
  const data = nested ? parsed.data : parsed;
  const warnings = [];

  const known = new Set([...CHARACTER_FIELDS.map(([field]) => field), "tags", "spec", "data", "character_book", "creator_notes", "creator", "character_version", "extensions"]);
  const unknown = Object.keys(data).filter(key => !known.has(key));
  if (unknown.length) warnings.push("已忽略未知字段: " + unknown.slice(0, 8).join("、") + (unknown.length > 8 ? " 等 " + unknown.length + " 个" : ""));

  const card = {};
  for (const [field, limit] of CHARACTER_FIELDS) {
    const value = data[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") { warnings.push("字段 " + field + " 不是字符串，已忽略。"); continue; }
    const text = field === "name" ? value.trim() : value;
    if (!text) continue;
    if (field === "name" && charCount(text) > limit) {
      card[field] = takeChars(text, limit);
      warnings.push("字段 " + field + " 超长，已截断到 " + limit + " 字符。");
    } else card[field] = text;
  }

  if (Array.isArray(data.tags)) {
    if (data.tags.length > MAX_TAGS) warnings.push("tags 超过 " + MAX_TAGS + " 个，已截断。");
    const tags = [];
    for (const item of data.tags) {
      if (typeof item !== "string") continue;
      const tag = takeChars(item.trim(), MAX_TAG_LENGTH);
      if (tag) tags.push(tag);
      if (tags.length >= MAX_TAGS) break;
    }
    if (tags.length) card.tags = tags;
  }

  for (const key of ["creator_notes", "creator", "character_version"]) if (typeof data[key] === "string") card[key] = data[key];
  if (data.extensions && typeof data.extensions === "object" && !Array.isArray(data.extensions)) card.extensions = structuredClone(data.extensions);
  if (data.character_book && Array.isArray(data.character_book.entries)) card.character_book = structuredClone(data.character_book);
  return {id: characterIdFor(card, owner), card, warnings};
}

export default parseCharacterCard;
