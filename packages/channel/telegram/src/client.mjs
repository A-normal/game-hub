import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";

export const telegramError = (code, message, extra = {}) => Object.assign(new Error(message), { code, publicMessage: message, ...extra });
export const FILE_LIMIT = 4 * 1024 * 1024;

export async function boundedBytes(response, maxBytes) {
  const size = Number(response.headers?.get("content-length"));
  if (size > maxBytes) { await response.body?.cancel(); throw telegramError("TG_FILE_TOO_LARGE", "Telegram 数据超过读取上限。"); }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw telegramError("TG_FILE_TOO_LARGE", "Telegram 数据超过读取上限。");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, length);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** All token-bearing URLs and proxy credentials stay inside this channel client. */
export class BotApiClient {
  #token; #base; #fetch; #agent; #closed = false; #timeoutMs; #lifecycle = new AbortController();
  constructor({ botApiToken, apiBaseUrl = "https://api.telegram.org", httpsProxyUrl = "", requestTimeoutMs = 15000, fetchImpl = undiciFetch } = {}) {
    if (typeof botApiToken !== "string" || !/^[0-9]+:[A-Za-z0-9_-]+$/.test(botApiToken) || botApiToken.length > 512) throw telegramError("TG_CONFIG", "TELEGRAM_BOT_API_TOKEN 格式无效。");
    let base, proxy;
    try {
      base = new URL(apiBaseUrl);
      if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error();
      if (httpsProxyUrl) {
        proxy = new URL(httpsProxyUrl);
        if (!["http:", "https:"].includes(proxy.protocol) || proxy.search || proxy.hash || proxy.pathname !== "/") throw new Error();
      }
    } catch { throw telegramError("TG_CONFIG", "Telegram API 地址须为 HTTPS，代理须为 HTTP(S)；请检查渠道配置。"); }
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 120000) throw telegramError("TG_CONFIG", "Telegram 请求超时配置无效。");
    this.#token = botApiToken; this.#base = base.href.replace(/\/+$/, ""); this.#fetch = fetchImpl; this.#timeoutMs = requestTimeoutMs;
    this.#agent = proxy ? new ProxyAgent(proxy.href) : new Agent({ connections: 4, pipelining: 1, connect: { timeout: 10000 } });
  }
  get tokenBotId() { return this.#token.split(":")[0]; }
  async #request(url, init, { signal, timeoutMs = this.#timeoutMs, maxBytes = FILE_LIMIT } = {}) {
    if (this.#closed) throw telegramError("TG_STOPPED", "Telegram 渠道已停止。");
    const combined = AbortSignal.any([this.#lifecycle.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    try {
      const response = await this.#fetch(url, { ...init, redirect: "error", signal: combined, dispatcher: this.#agent });
      const bytes = await boundedBytes(response, maxBytes);
      return { response, bytes };
    } catch (error) {
      if (error?.code === "TG_FILE_TOO_LARGE") throw error;
      if (signal?.aborted || this.#closed) throw telegramError("TG_STOPPED", "Telegram 请求已取消。", { uncertain: true });
      throw telegramError("TG_NETWORK", "Telegram 网络请求失败或超时，未自动重发。", { uncertain: true });
    }
  }
  async call(method, params = {}, { signal, timeoutMs, form } = {}) {
    if (!/^[a-z][A-Za-z0-9]+$/.test(method)) throw telegramError("TG_METHOD", "Telegram API 方法无效。");
    const { response, bytes } = await this.#request(`${this.#base}/bot${this.#token}/${method}`, {
      method: "POST", headers: form ? undefined : { "content-type": "application/json" }, body: form ?? JSON.stringify(params)
    }, { signal, timeoutMs });
    let body;
    try { body = JSON.parse(bytes.toString("utf8")); }
    catch { throw telegramError("TG_PROTOCOL", "Telegram 返回了无效响应。", { uncertain: true }); }
    if (!response.ok || body.ok !== true) {
      const status = Number(body.error_code) || response.status;
      const retry = Number(body.parameters?.retry_after);
      const code = status === 429 ? "TG_RATE_LIMIT" : status === 401 ? "TG_AUTH" : status === 409 ? "TG_CONFLICT" : "TG_API";
      throw telegramError(code, `Telegram API 请求失败（${Number.isInteger(status) ? status : 0}）。`, {
        status, retryAfter: Number.isFinite(retry) && retry > 0 ? Math.min(Math.ceil(retry), 3600) : 1
      });
    }
    return body.result;
  }
  async readFile(fileId, { maxBytes = FILE_LIMIT, signal } = {}) {
    if (typeof fileId !== "string" || !fileId || fileId.length > 1024 || /[\s/\\:]/.test(fileId)) throw telegramError("TG_FILE_INVALID", "Telegram 文件标识无效。");
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 20 * 1024 * 1024) throw telegramError("TG_FILE_LIMIT", "Telegram 文件读取上限无效。");
    const file = await this.call("getFile", { file_id: fileId }, { signal });
    if (Number(file?.file_size) > maxBytes) throw telegramError("TG_FILE_TOO_LARGE", "文件超过读取大小上限。");
    const relative = file?.file_path;
    if (typeof relative !== "string" || !relative || relative.startsWith("/") || /[\\:\x00-\x1f\x7f]/.test(relative) || relative.split("/").some(part => !part || part === "." || part === "..")) throw telegramError("TG_FILE_INVALID", "Telegram 未提供有效的文件路径。");
    const encoded = relative.split("/").map(encodeURIComponent).join("/");
    const { response, bytes } = await this.#request(`${this.#base}/file/bot${this.#token}/${encoded}`, { method: "GET" }, { signal, maxBytes });
    if (!response.ok) throw telegramError("TG_FILE_UNAVAILABLE", "Telegram 文件暂时不可用。");
    return bytes;
  }
  async close() { if (!this.#closed) { this.#closed = true; this.#lifecycle.abort(); await this.#agent.destroy(); } }
}
