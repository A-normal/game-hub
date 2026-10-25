/**
 * @file packages/core/src/shaper/inbound-shaper.mjs
 * @description 渠道入站事件轻量整形器：将各渠道事件规范化为标准 EventEnvelope (解决 P1-07)
 */

import { Platforms } from "../types.mjs";
import crypto from "node:crypto";

export class InboundShaper {
  /**
   * 将多渠道入站事件转换为规范化的 IEventEnvelope
   * @param {Object} rawEvent - 渠道原生事件
   * @param {Object} [options]
   * @param {(target: any, msg: any) => Promise<any>} [options.sendFunction] - 实际发送闭包
   * @returns {import('../types.mjs').IEventEnvelope}
   */
  static shape(rawEvent, options = {}) {
    let platform = Platforms.MOCK;
    let rawUserId = String(rawEvent.user_id || rawEvent.from?.id || rawEvent.sender?.id || "unknown");
    let rawText = rawEvent.message_text || rawEvent.raw_message || rawEvent.text || rawEvent.msg || "";
    let cleanText = rawText.trim();
    let isGroup = Boolean(rawEvent.group_id || rawEvent.chat?.type === "group" || rawEvent.message_type === "group");
    let groupId = rawEvent.group_id ? String(rawEvent.group_id) : (rawEvent.chat?.id ? String(rawEvent.chat.id) : undefined);
    let messageId = String(rawEvent.message_id || rawEvent.msg_id || `mock-${Date.now()}`);
    let timestamp = rawEvent.time || rawEvent.date || Math.floor(Date.now() / 1000);

    // 平台识别与 @Bot 剥离
    if (rawEvent.post_type === "message" || rawEvent.message_type) {
      platform = Platforms.NAPCAT;
    } else if (rawEvent.update_id || rawEvent.chat) {
      platform = Platforms.TELEGRAM;
      // Telegram: 自动剥离群聊中的 @bot_username
      if (rawEvent.bot_username) {
        const atRegex = new RegExp(`@${rawEvent.bot_username}\\b`, "gi");
        cleanText = cleanText.replace(atRegex, "").trim();
      }
    }

    const unifiedUserId = `${platform}:${rawUserId}`;
    const eventId = crypto.createHash("md5").update(`${platform}:${messageId}:${timestamp}`).digest("hex");

    const sender = {
      id: rawUserId,
      name: rawEvent.sender?.nickname || rawEvent.sender?.name || rawEvent.from?.first_name || "User",
      role: rawEvent.sender?.role || "member"
    };

    // 封装回复闭包，统一返回 IDeliveryResult
    const reply = async (content, replyOpts = {}) => {
      if (typeof options.sendFunction === "function") {
        return options.sendFunction({ isGroup, groupId, userId: rawUserId, messageId }, content, replyOpts);
      }
      if (typeof rawEvent.reply === "function") {
        await rawEvent.reply(content, replyOpts);
        return { success: true, messageId };
      }
      return { success: true, messageId };
    };

    return {
      eventId,
      botId: rawEvent.self_id ? String(rawEvent.self_id) : undefined,
      messageId,
      platform,
      unifiedUserId,
      rawText,
      cleanText,
      isGroup,
      groupId,
      timestamp,
      sender,
      reply
    };
  }
}

export default InboundShaper;
