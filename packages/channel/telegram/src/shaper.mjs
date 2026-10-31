const numericId = (value, positive = false) => Number.isSafeInteger(value) && (positive ? value > 0 : value !== 0);
const media = message => {
  const files = [];
  if (message.document?.file_id) files.push({ id: message.document.file_id, name: message.document.file_name || "document", size: message.document.file_size, type: "file" });
  const photo = message.photo?.at(-1);
  if (photo?.file_id) files.push({ id: photo.file_id, name: "photo.jpg", size: photo.file_size, type: "image" });
  return files;
};

/** Telegram-specific parsing remains in the channel, not in business plugins. */
export function shapeUpdate(update, { bot, send, readAttachment }) {
  const message = update?.message;
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0 || !message || message.sender_chat || message.from?.is_bot || !numericId(message.from?.id, true) || !numericId(message.chat?.id) || !numericId(message.message_id, true)) return null;
  if (!["private", "group", "supergroup"].includes(message.chat.type)) return null;
  if (message.chat.type === "private" && message.chat.id !== message.from.id) return null;
  const rawText = message.text ?? message.caption ?? "";
  if (typeof rawText !== "string") return null;
  const attachments = media(message).map(file => ({ ...file, readBytes: limits => readAttachment(file, limits) }));
  if (!rawText && !attachments.length) return null;
  const botId = String(bot.id), username = String(bot.username || "").toLowerCase();
  const mentions = [], removals = [];
  let commandHint = /^\//.test(rawText.trim()), addressedElsewhere = false;
  const entities = message.entities ?? message.caption_entities ?? [];
  for (const entity of Array.isArray(entities) ? entities : []) {
    if (!Number.isInteger(entity.offset) || !Number.isInteger(entity.length) || entity.offset < 0 || entity.length < 1 || entity.offset + entity.length > rawText.length) continue;
    const value = rawText.slice(entity.offset, entity.offset + entity.length);
    if (entity.type === "mention" && username && value.toLowerCase() === "@" + username) {
      mentions.push({ id: botId });
      // Addressing tokens are removed; mentions inside structured arguments are preserved.
      if (!rawText.slice(0, entity.offset).trim() || (entity.offset + entity.length === rawText.length && /\s/.test(rawText[entity.offset - 1] || ""))) removals.push([entity.offset, entity.offset + entity.length]);
    }
    if (entity.type === "text_mention" && numericId(entity.user?.id, true)) mentions.push({ id: String(entity.user.id) });
    if (entity.type === "bot_command") {
      const before = rawText.slice(0, entity.offset).trim().toLowerCase();
      if (before && before !== "@" + username) continue;
      commandHint = true;
      const at = value.indexOf("@");
      if (at >= 0) {
        if (value.slice(at + 1).toLowerCase() !== username) addressedElsewhere = true;
        else { removals.push([entity.offset + at, entity.offset + entity.length]); mentions.push({ id: botId }); }
      }
    }
  }
  if (addressedElsewhere) return null;
  let cleanText = rawText;
  for (const [start, end] of removals.sort((a, b) => b[0] - a[0])) cleanText = cleanText.slice(0, start) + cleanText.slice(end);
  const userId = String(message.from.id), chatId = String(message.chat.id), isGroup = message.chat.type !== "private";
  const threadId = numericId(message.message_thread_id, true) ? String(message.message_thread_id) : undefined;
  const quoted = message.reply_to_message;
  const target = { platform: "telegram", botId, isGroup, chatId, groupId: isGroup ? chatId : undefined, userId, messageId: String(message.message_id), threadId };
  return {
    eventType: "message", eventId: `telegram:${botId}:${update.update_id}`, messageId: target.messageId,
    platform: "telegram", botId, chatId, threadId, unifiedUserId: "telegram:" + userId,
    rawText, cleanText: cleanText.trim(), isGroup, groupId: target.groupId, commandHint: commandHint || /^\//.test(cleanText.trim()),
    timestamp: Number.isSafeInteger(message.date) ? message.date : Math.floor(Date.now() / 1000),
    sender: { id: userId, name: [message.from.first_name, message.from.last_name].filter(Boolean).join(" ") || "User", role: "member" },
    mentions, mentionedBot: mentions.some(item => item.id === botId), replyToBot: quoted?.from?.id === bot.id,
    attachments: attachments.length ? attachments : undefined,
    images: attachments.filter(file => file.type === "image").map(file => ({ file: "telegram-file:" + file.id })),
    replyMessage: quoted ? { id: String(quoted.message_id), text: quoted.text ?? quoted.caption ?? "", images: media(quoted).filter(file => file.type === "image").map(file => ({ file: "telegram-file:" + file.id })) } : undefined,
    reply: (content, options = {}) => send(target, content, options)
  };
}
