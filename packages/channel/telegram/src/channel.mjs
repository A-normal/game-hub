import { logger } from "@game-hub/core";
import { BotApiClient, FILE_LIMIT, telegramError } from "./client.mjs";
import { TelegramDelivery, sleep } from "./files.mjs";
import { shapeUpdate } from "./shaper.mjs";

const WEEK = 7 * 24 * 60 * 60 * 1000;
export class TelegramChannel {
  #client; #dispatcher; #vault; #controller = new AbortController(); #loop; #starting; #delivery; #sleep; #now; #stateKey; #offset = 0; #lastUpdateAt = 0; #stopped = false;
  constructor({ config, dispatcher, vault, client, fetchImpl, sleepImpl = sleep, now = Date.now, pacing = true }) {
    if (!dispatcher?.dispatch || !vault?.getSetting || !vault?.setSetting) throw telegramError("TG_CONFIG", "Telegram 渠道需要核心调度器和持久存储。");
    this.#client = client ?? new BotApiClient({ ...config, fetchImpl }); this.#dispatcher = dispatcher; this.#vault = vault;
    this.#sleep = sleepImpl; this.#now = now; this.pacing = pacing;
    this.pollTimeoutSeconds = config.pollTimeoutSeconds ?? 25; this.maxAttachmentBytes = config.maxAttachmentBytes ?? FILE_LIMIT;
    this.id = "telegram"; this.kind = "channel"; this.contractVersion = 1; this.platforms = ["telegram"];
    this.capabilities = ["text", "image", "quote", "file", "attachment-read", "thread"]; this.status = "created";
  }
  start() {
    if (this.#starting) return this.#starting;
    if (this.#stopped) return Promise.reject(telegramError("TG_STOPPED", "Telegram 渠道已停止，请创建新实例。"));
    this.#starting = this.#start(); return this.#starting;
  }
  async #start() {
    const signal = this.#controller.signal;
    try {
      const bot = await this.#client.call("getMe", {}, { signal });
      if (!Number.isSafeInteger(bot?.id) || bot.id < 1 || bot.is_bot !== true || this.#client.tokenBotId && String(bot.id) !== this.#client.tokenBotId) throw telegramError("TG_IDENTITY", "Telegram 未返回匹配的机器人身份。");
      const webhook = await this.#client.call("getWebhookInfo", {}, { signal });
      if (typeof webhook?.url !== "string") throw telegramError("TG_PROTOCOL", "Telegram webhook 状态无效。");
      if (webhook.url) throw telegramError("TG_WEBHOOK_CONFIGURED", "Telegram 已设置 webhook，请维护者确认切换为长轮询后再启动；渠道不会自动删除远端配置。");
      this.bot = { id: bot.id, username: typeof bot.username === "string" ? bot.username : "" };
      this.#stateKey = `channel:telegram:${bot.id}:cursor`;
      const state = this.#vault.getSetting(this.#stateKey, { nextUpdateId: 0, lastUpdateAt: 0 });
      if (!Number.isSafeInteger(state?.nextUpdateId) || state.nextUpdateId < 0 || !Number.isFinite(state.lastUpdateAt) || state.lastUpdateAt < 0) throw telegramError("TG_CURSOR_INVALID", "Telegram 持久进度格式无效，请核对数据备份。");
      this.#offset = state.nextUpdateId; this.#lastUpdateAt = state.lastUpdateAt;
      this.#delivery = new TelegramDelivery({ client: this.#client, botId: String(bot.id), signal, maxAttachmentBytes: this.maxAttachmentBytes, sleepImpl: this.#sleep, now: this.#now, pacing: this.pacing });
      if (signal.aborted) throw telegramError("TG_STOPPED", "Telegram 渠道启动已取消。");
      this.status = "running";
      if (bot.can_read_all_group_messages !== true) logger.info("Telegram", "机器人启用群隐私模式；普通群消息可见性取决于群权限，配置方法见 Telegram 渠道包文档。");
      this.#loop = this.#poll(signal);
    } catch (error) {
      this.status = "failed"; this.#controller.abort(); await this.#client.close(); throw error;
    }
  }
  async #poll(signal) {
    let failures = 0;
    while (!signal.aborted && this.status === "running") {
      try {
        // Telegram may randomize update IDs after a week without new updates.
        if (this.#lastUpdateAt && this.#now() - this.#lastUpdateAt >= WEEK) this.#offset = 0;
        const updates = await this.#client.call("getUpdates", { offset: this.#offset, timeout: this.pollTimeoutSeconds, limit: 100, allowed_updates: ["message"] }, { signal, timeoutMs: (this.pollTimeoutSeconds + 10) * 1000 });
        if (!Array.isArray(updates) || updates.some(update => !Number.isSafeInteger(update?.update_id) || update.update_id < 0 || update.update_id >= Number.MAX_SAFE_INTEGER)) throw telegramError("TG_PROTOCOL", "Telegram 更新批次无效。");
        for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) {
          if (signal.aborted) break;
          if (update.update_id < this.#offset) continue;
          const state = { nextUpdateId: update.update_id + 1, lastUpdateAt: this.#now() };
          try { this.#vault.setSetting(this.#stateKey, state); }
          catch { throw telegramError("TG_CURSOR_STORE", "Telegram 进度保存失败，已停止接收，未分发该条更新。"); }
          this.#offset = state.nextUpdateId; this.#lastUpdateAt = state.lastUpdateAt;
          const event = shapeUpdate(update, { bot: this.bot, send: (target, content, options) => this.send(target, content, options), readAttachment: (file, limits) => this.readAttachment(file, limits) });
          if (!event) continue;
          event.channelCapabilities = [...this.capabilities];
          try {
            if (/^\/start(?:\s|$)/i.test(event.cleanText)) {
              const auth = this.#dispatcher.formatCommand({ pluginId: "system", routeId: "auth", args: ["<系统管理员注册令牌>"] });
              await event.reply(`Game-Hub Telegram 渠道已接入。\n系统管理员注册请在私聊发送：${auth}\n业务命令使用各插件当前的调用标记。`);
            } else await this.#dispatcher.dispatch(event);
          } catch { logger.warn("Telegram", "消息处理失败，已认领的更新不会自动重放；正文与凭据不写入日志。"); }
        }
        failures = 0;
        if (!updates.length) await this.#sleep(250, signal);
      } catch (error) {
        if (signal.aborted) break;
        if (["TG_AUTH", "TG_CONFLICT", "TG_PROTOCOL", "TG_CURSOR_STORE", "TG_FILE_TOO_LARGE"].includes(error.code) || error.code === "TG_API" && error.status >= 400 && error.status < 500) {
          this.status = "failed"; this.failureCode = error.code;
          logger.error("Telegram", `接收已停止 code=${error.code}，请检查机器人凭据、独占轮询或持久目录。`); break;
        }
        failures++;
        logger.warn("Telegram", `接收暂时失败 code=${error.code === "TG_RATE_LIMIT" ? "TG_RATE_LIMIT" : "TG_NETWORK"}，等待后重连。`);
        try { await this.#sleep(error.code === "TG_RATE_LIMIT" ? error.retryAfter * 1000 : Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)), signal); }
        catch { break; }
      }
    }
  }
  async readAttachment(file, { maxBytes = FILE_LIMIT } = {}) {
    if (this.status !== "running") throw telegramError("TG_STOPPED", "Telegram 渠道尚未就绪或已停止。");
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 20 * 1024 * 1024) throw telegramError("TG_FILE_LIMIT", "附件读取上限无效。");
    const limit = Math.min(maxBytes, this.maxAttachmentBytes);
    if (Number(file.size) > limit) throw telegramError("TG_FILE_TOO_LARGE", "附件超过当前读取上限。");
    return this.#client.readFile(file.id, { maxBytes: limit, signal: this.#controller.signal });
  }
  send(target, content, options = {}) {
    if (this.status !== "running" || !this.#delivery) return Promise.resolve({ success: false, error: "Telegram 渠道尚未就绪或已停止。" });
    return this.#delivery.send(target, content, options);
  }
  async stop() {
    if (this.#stopped) return;
    this.#stopped = true; this.#controller.abort();
    await this.#starting?.catch(() => {}); await this.#loop;
    await this.#delivery?.drain(); await this.#client.close(); this.status = "stopped";
  }
}
