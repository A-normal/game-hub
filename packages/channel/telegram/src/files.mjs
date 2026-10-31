import { FormData } from "undici";
import { FILE_LIMIT, telegramError } from "./client.mjs";

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(telegramError("TG_STOPPED", "Telegram 渠道已停止。")); return; }
  const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
  const timer = setTimeout(finish, Math.max(0, ms));
  const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(telegramError("TG_STOPPED", "Telegram 渠道已停止。")); };
  signal?.addEventListener("abort", abort, { once: true });
});

function textParts(text) {
  const parts = []; let current = "";
  for (const character of text) {
    if (current.length + character.length > 4096) { parts.push(current); current = ""; }
    current += character;
  }
  if (current) parts.push(current);
  return parts.map(text => ({ method: "sendMessage", params: { text } }));
}
function imagePart(file, maxBytes) {
  if (typeof file !== "string") throw telegramError("TG_MEDIA_INVALID", "图片只支持 HTTPS 或有界 base64 数据。");
  if (file.startsWith("base64://")) {
    const base64 = file.slice(9);
    if (base64.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw telegramError("TG_MEDIA_INVALID", "图片数据无效或超过大小上限。");
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length || bytes.length > maxBytes) throw telegramError("TG_MEDIA_INVALID", "图片数据无效或超过大小上限。");
    return { method: "sendPhoto", upload: { field: "photo", name: "image.png", bytes } };
  }
  let url;
  try { url = new URL(file); } catch {}
  if (!url || url.protocol !== "https:" || url.username || url.password || url.hash) throw telegramError("TG_MEDIA_INVALID", "图片地址须为不含凭据的 HTTPS 地址，不支持本地路径。");
  return { method: "sendPhoto", params: { photo: url.href } };
}

/** Validate every part before sending anything, preserving partial-delivery semantics. */
export function prepareDelivery(content, maxBytes = FILE_LIMIT) {
  const parts = [], files = content?.files ?? [];
  if (!Array.isArray(files) || files.length > 5) throw telegramError("TG_MEDIA_INVALID", "一次最多发送五个文件。");
  if (content?.segments !== undefined) {
    if (!Array.isArray(content.segments) || content.segments.length > 50) throw telegramError("TG_MEDIA_INVALID", "消息段格式无效或过多。");
    for (const segment of content.segments) {
      if (segment?.type === "text") parts.push(...textParts(String(segment.text || "")));
      else if (segment?.type === "image") parts.push(imagePart(segment.file, maxBytes));
      else throw telegramError("TG_MEDIA_INVALID", "Telegram 不支持此消息段。");
    }
  }
  const text = typeof content === "string" ? content : String(content?.text ?? content?.content ?? "");
  parts.push(...textParts(text));
  for (const file of files) {
    if (typeof file?.name !== "string" || !/^[^\\/\x00-\x1f]{1,120}$/.test(file.name) || [".", ".."].includes(file.name) || !Buffer.isBuffer(file.data) || !file.data.length || file.data.length > maxBytes) throw telegramError("TG_MEDIA_INVALID", "文件名、Buffer 数据或文件大小无效。");
    parts.push({ method: "sendDocument", upload: { field: "document", name: file.name, bytes: file.data } });
  }
  if (!parts.length || parts.length > 100) throw telegramError("TG_MEDIA_INVALID", "消息为空或分段过多。");
  return parts;
}

export class TelegramDelivery {
  #client; #signal; #sleep; #now; #queues = new Map(); #lastSend = new Map(); #globalNext = 0; #pending = 0;
  constructor({ client, botId, signal, maxAttachmentBytes = FILE_LIMIT, sleepImpl = sleep, now = Date.now, pacing = true }) {
    this.#client = client; this.botId = botId; this.#signal = signal; this.#sleep = sleepImpl; this.#now = now;
    this.maxAttachmentBytes = maxAttachmentBytes; this.pacing = pacing;
  }
  async send(target, content, options = {}) {
    if (this.#signal.aborted) return { success: false, error: "Telegram 渠道已停止。" };
    if (target?.platform && target.platform !== "telegram" || target?.botId && String(target.botId) !== this.botId) throw telegramError("TG_TARGET_INVALID", "Telegram 消息目标不属于当前机器人。");
    const chatId = String(target?.chatId ?? (target?.isGroup ? target?.groupId : target?.userId) ?? "");
    if (!/^-?[1-9][0-9]*$/.test(chatId) || !Number.isSafeInteger(Number(chatId))) throw telegramError("TG_TARGET_INVALID", "Telegram 目标聊天 ID 无效。");
    if (target.threadId !== undefined && (!/^[1-9][0-9]*$/.test(String(target.threadId)) || !Number.isSafeInteger(Number(target.threadId)))) throw telegramError("TG_TARGET_INVALID", "Telegram 目标话题 ID 无效。");
    if (this.#pending >= 100) return { success: false, error: "Telegram 发送队列已满。" };
    const parts = prepareDelivery(content, this.maxAttachmentBytes);
    const before = this.#queues.get(chatId) ?? Promise.resolve();
    this.#pending++;
    const task = before.catch(() => {}).then(() => this.#deliver(chatId, target, parts, options));
    this.#queues.set(chatId, task);
    try { return await task; }
    finally { this.#pending--; if (this.#queues.get(chatId) === task) this.#queues.delete(chatId); }
  }
  async #pace(chatId, isGroup) {
    if (!this.pacing) return;
    const perChat = Math.max(0, (this.#lastSend.get(chatId) ?? 0) + (isGroup ? 3100 : 1050) - this.#now());
    if (perChat) await this.#sleep(perChat, this.#signal);
    const at = Math.max(this.#now(), this.#globalNext); this.#globalNext = at + 40;
    if (at > this.#now()) await this.#sleep(at - this.#now(), this.#signal);
  }
  async #deliver(chatId, target, parts, options) {
    const ids = [];
    try {
      for (const [index, part] of parts.entries()) {
        if (this.#signal.aborted) throw telegramError("TG_STOPPED", "Telegram 渠道已停止。");
        const params = { chat_id: chatId, ...part.params };
        if (target.threadId !== undefined) params.message_thread_id = Number(target.threadId);
        if (index === 0 && options.quote && /^[1-9][0-9]*$/.test(String(target.messageId ?? ""))) params.reply_parameters = { message_id: Number(target.messageId), allow_sending_without_reply: true };
        let sent;
        for (let attempt = 0; ; attempt++) {
          await this.#pace(chatId, !!target.isGroup);
          let form;
          if (part.upload) {
            form = new FormData();
            for (const [key, value] of Object.entries(params)) form.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
            form.append(part.upload.field, new Blob([part.upload.bytes]), part.upload.name);
          }
          try { sent = await this.#client.call(part.method, params, { signal: this.#signal, form }); break; }
          catch (error) {
            if (error.code !== "TG_RATE_LIMIT" || attempt >= 1) throw error;
            await this.#sleep(error.retryAfter * 1000, this.#signal);
          }
        }
        if (!Number.isSafeInteger(sent?.message_id) || sent.message_id < 1) throw telegramError("TG_PROTOCOL", "Telegram 未返回有效消息标识。", { uncertain: true });
        ids.push(String(sent.message_id)); this.#lastSend.set(chatId, this.#now());
        if (this.#lastSend.size > 10000) this.#lastSend.delete(this.#lastSend.keys().next().value);
      }
      return { success: true, messageId: ids[0], messageIds: ids, partsDelivered: ids.length };
    } catch (error) {
      return { success: false, partial: ids.length > 0, partsDelivered: ids.length, messageIds: ids, uncertain: !!error.uncertain, errorCode: /^TG_[A-Z_]+$/.test(error.code || "") ? error.code : "TG_DELIVERY", error: "Telegram 消息交付失败，已交付部分或结果不明的请求不会自动重发。" };
    }
  }
  async drain() { await Promise.allSettled([...this.#queues.values()]); }
}
