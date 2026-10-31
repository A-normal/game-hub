/**
 * @file packages/core/src/shaper/inbound-shaper.mjs
 * @description 渠道入站事件轻量整形器：将各渠道事件规范化为标准 EventEnvelope (解决 P1-07)
 */

import { Platforms } from "../types.mjs";
import crypto from "node:crypto";

export class InboundShaper {
  /**
   * 脱敏日志文本中的敏感令牌与 Cookie
   * @param {string} text
   * @returns {string}
   */
  static sanitizeLogText(text) {
    if (!text || typeof text !== "string") return "";
    return text
      .replace(/((?:绑定设备|设备配置)\s+)[\s\S]*/gi, "$1***")
      .replace(/(["']?(?:oaid|deviceFingerprint|deviceName|deviceBoard|deviceModel|deviceProduct|device_id|device_fp)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1***")
      .replace(/((?:["']?(?:ltoken(?:_v2)?|stoken(?:_v2)?|cookie_token(?:_v2)?|login_ticket|ticket|authkey|access_token|refresh_token|password|GAMEHUB_ADMIN_REGISTRATION_TOKEN|NAPCAT_TO_GAMEHUB_CONNECTION_TOKEN|CHATAI_ADMIN_REGISTRATION_TOKEN|TELEGRAM_BOT_API_TOKEN|botApiToken|GAMEHUB_TOKEN|CHATAI_ADMIN_TOKEN)["']?)\s*[:=]\s*["']?)[^\s;,&"'\]}]+/gi, "$1***")
      .replace(/(\/(?:file\/)?bot)[0-9]+:[A-Za-z0-9_-]+/gi, "$1***")
      .replace(/\b[0-9]{5,}:[A-Za-z0-9_-]{20,}\b/g, "***")
      .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1***@")
      .replace(/((?:stoken|ltoken|cookie_token|authkey|ticket|access_token)(?:_v2)?%3[dD])[^&\s]+/gi, "$1***")
      .replace(/(authorization\s*[:=]\s*["']?(?:Bearer\s+)?)[^\s,"'}]+/gi, "$1***")
      .replace(/(ltoken(?:_v2)?=)[^;\s]+/gi, "$1***")
      .replace(/(stoken(?:_v2)?=)[^;\s]+/gi, "$1***")
      .replace(/(cookie_token(?:_v2)?=)[^;\s]+/gi, "$1***")
      .replace(/(authkey=)[^&\s]+/gi, "$1***")
      .replace(/((?:auth|认证)\s+)\S+/gi, "$1***");
  }

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
    let rawText = rawEvent.message_text || rawEvent.raw_message || rawEvent.text || rawEvent.msg || (Array.isArray(rawEvent.message) ? rawEvent.message.filter(seg=>seg.type==="text").map(seg=>seg.data?.text || "").join("") : typeof rawEvent.message==="string" ? rawEvent.message : "");
    let cleanText = (Array.isArray(rawEvent.message)
      ? rawEvent.message.filter(seg => seg?.type === "text").map(seg => seg.data?.text || "").join("")
      : rawText.replace(/\[CQ:[^\]]*\]/gi, "")).trim();
    let isGroup = Boolean(rawEvent.group_id || rawEvent.chat?.type === "group" || rawEvent.message_type === "group");
    let groupId = rawEvent.group_id ? String(rawEvent.group_id) : (rawEvent.chat?.id ? String(rawEvent.chat.id) : undefined);
    let messageId = String(rawEvent.message_id || rawEvent.msg_id || (rawEvent.post_type === "notice" ? `notice:${rawEvent.self_id}:${rawEvent.notice_type}:${rawEvent.sub_type}:${rawEvent.group_id}:${rawEvent.user_id}:${rawEvent.target_id}:${rawEvent.time}` : `mock-${Date.now()}`));
    let timestamp = rawEvent.time || rawEvent.date || Math.floor(Date.now() / 1000);

    // 平台识别与 @Bot 剥离
    if (["message","notice","request"].includes(rawEvent.post_type) || rawEvent.message_type) {
      platform = Platforms.NAPCAT;
    } else if (rawEvent.update_id || rawEvent.chat) {
      platform = Platforms.TELEGRAM;
      // Telegram: 自动剥离群聊中的 @bot_username
      if (rawEvent.bot_username) {
        const atRegex = new RegExp(`@${rawEvent.bot_username}\\b`, "gi");
        cleanText = cleanText.replace(atRegex, "").trim();
      }
    }

    // 提取图片附件
    const images = [];
    const attachments = [];
    const addAttachment=(file,type="file")=>{
      if(!file)return;
      const attachment={id:String(file.id || file.file_id || file.file || ""),name:String(file.name || file.file_name || ""),size:Number(file.size ?? file.file_size) || undefined,type};
      if(typeof options.readAttachment==="function")attachment.readBytes=limits=>options.readAttachment(attachment,limits);
      attachments.push(attachment);
    };
    if(["offline_file","group_upload"].includes(rawEvent.notice_type))addAttachment(rawEvent.file);
    if(!Array.isArray(rawEvent.message)) {
      const unescape=value=>value.replace(/&#44;/g,",").replace(/&#91;/g,"[").replace(/&#93;/g,"]").replace(/&amp;/g,"&");
      for(const segment of rawText.matchAll(/\[CQ:(file|image),([^\]]+)\]/gi)) {
        const fields=Object.fromEntries(segment[2].split(",").map(item=>{const index=item.indexOf("=");return index<0?[]:[item.slice(0,index),unescape(item.slice(index+1))];}).filter(item=>item.length===2));
        addAttachment(fields,segment[1].toLowerCase());
      }
    }
    if (Array.isArray(rawEvent.message)) {
      for (const seg of rawEvent.message) {
        if(seg?.type==="file")addAttachment(seg.data);
        if (seg.type === "image" && seg.data) {
          images.push({ url: seg.data.url || seg.data.file, file: seg.data.file });
          addAttachment(seg.data,"image");
        }
      }
    }
    const cqImageRegex = /\[CQ:image,([^\]]+)\]/gi;
    let match;
    while ((match = cqImageRegex.exec(rawText)) !== null) {
      const attrs = Object.fromEntries(match[1].split(",").map(kv => {
        const p = kv.indexOf("=");
        return p > 0 ? [kv.slice(0, p).trim(), kv.slice(p + 1).trim()] : [];
      }).filter(kv => kv.length === 2));
      if (attrs.file || attrs.url) {
        images.push({ url: attrs.url || attrs.file, file: attrs.file });
      }
    }
    const tgPhoto = rawEvent.photo || rawEvent.message?.photo;
    if (Array.isArray(tgPhoto) && tgPhoto.length > 0) {
      const largest = tgPhoto.at(-1);
      images.push({ url: largest.file_url || largest.file_id, file: largest.file_id });
    }

    // 提取引用/回复消息
    let replyMessage = undefined;
    let replyId = undefined;
    if (Array.isArray(rawEvent.message)) {
      const replySeg = rawEvent.message.find(seg => seg.type === "reply");
      if (replySeg?.data?.id) replyId = String(replySeg.data.id);
    }
    const cqReplyMatch = /\[CQ:reply,id=([^\]]+)\]/i.exec(rawText);
    if (cqReplyMatch) replyId = cqReplyMatch[1].split(",")[0].trim();

    if (rawEvent.reply_to_message) {
      replyId = String(rawEvent.reply_to_message.message_id || replyId);
      const replyImages = [];
      if (Array.isArray(rawEvent.reply_to_message.photo)) {
        const largest = rawEvent.reply_to_message.photo.at(-1);
        replyImages.push({ url: largest.file_url || largest.file_id, file: largest.file_id });
      }
      replyMessage = {
        id: replyId,
        text: rawEvent.reply_to_message.text || "",
        images: replyImages
      };
    } else if (rawEvent.source) {
      replyId = String(rawEvent.source.id || rawEvent.source.message_id || replyId);
      const replyImages = [];
      if (Array.isArray(rawEvent.source.message)) {
        for (const seg of rawEvent.source.message) {
          if (seg.type === "image" && seg.data) {
            replyImages.push({ url: seg.data.url || seg.data.file, file: seg.data.file });
          }
        }
      }
      replyMessage = {
        id: replyId,
        text: rawEvent.source.raw_message || rawEvent.source.message || "",
        images: replyImages
      };
    } else if (replyId) {
      replyMessage = { id: replyId };
    }

    // 提取 @ 提及：只认 message 段中的 at 段；`all` 原样保留，其余统一字符串化。
    const mentions = [];
    if (Array.isArray(rawEvent.message)) {
      for (const seg of rawEvent.message) {
        if (seg?.type !== "at") continue;
        const qq = seg.data?.qq;
        if (qq === undefined || qq === null || qq === "") continue;
        mentions.push({ id: String(qq) });
      }
    }
    if (!Array.isArray(rawEvent.message)) {
      for (const item of rawText.matchAll(/\[CQ:at,qq=([^,\]]+)[^\]]*\]/gi)) mentions.push({id: item[1]});
    }
    const selfId = rawEvent.self_id === undefined || rawEvent.self_id === null ? null : String(rawEvent.self_id);
    const mentionedBot = selfId !== null && mentions.some(item => item.id === selfId);

    const unifiedUserId = `${platform}:${rawUserId}`;
    const eventId = crypto.createHash("md5").update(`${platform}:${rawEvent.self_id || ""}:${rawEvent.post_type || "message"}:${rawEvent.notice_type || ""}:${messageId}:${timestamp}`).digest("hex");

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
      eventType: rawEvent.post_type === "notice" ? "notice" : "message",
      noticeType: rawEvent.notice_type || undefined,
      noticeSubtype: rawEvent.sub_type || undefined,
      targetUserId: rawEvent.target_id == null ? undefined : String(rawEvent.target_id),
      recalledMessageId: ["group_recall","friend_recall"].includes(rawEvent.notice_type) && rawEvent.message_id!=null ? String(rawEvent.message_id) : undefined,
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
      images: images.length > 0 ? images : undefined,
      attachments: attachments.length ? attachments : undefined,
      replyMessage,
      reply,
      mentions,
      mentionedBot
    };
  }
}

export default InboundShaper;
