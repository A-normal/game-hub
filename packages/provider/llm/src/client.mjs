/**
 * @file packages/provider/llm/src/client.mjs
 * @description OpenAI 兼容 /chat/completions 客户端。
 *              零第三方依赖；fetch、时钟与 sleep 均可注入，导入阶段绝不发请求。
 */

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRY_DELAY_MS = 250;
/** 首次请求 + 连接类失败最多重试 1 次。 */
const MAX_ATTEMPTS = 2;

/** 模型密钥只能通过 CHATAI_KEY_ 前缀的环境变量引用。 */
export const API_KEY_ENV_PATTERN = /^CHATAI_KEY_[A-Z0-9_]{1,56}$/;
/** 即使前缀规则放宽，这些系统敏感变量也永远不允许被引用。 */
export const API_KEY_ENV_DENYLIST = Object.freeze(["GAMEHUB_TOKEN", "VAULT_SECRET", "ACCESS_TOKEN", "MASTER_QQ", "GAMEHUB_ADMIN_USERS"]);
const DENIED_KEY_ENVS = new Set(API_KEY_ENV_DENYLIST);
const PRIVATE_IPV4 = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./, /^127\./];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/**
 * 归一化 OpenAI 兼容聊天端点（纯函数，不抛异常）。
 * 规则：
 * 1. trim 去除首尾空白；非字符串或空值返回错误；
 * 2. 必须是合法 URL 且包含主机名；
 * 3. 不接受包含 query 参数或 hash 片段的端点；
 * 4. path 为空或 "/" → 追加 "/v1/chat/completions"；
 * 5. path 以 "/chat/completions" 结尾（忽略末尾 "/"）→ 原样保留；
 * 6. path 以 "/v1"（或 "/vN"）结尾或其它非空 path → 追加 "/chat/completions"。
 * @param {unknown} endpoint
 * @returns {{ok:true, url:string}|{ok:false, reason:string}}
 */
export function normalizeChatEndpoint(endpoint) {
  if (typeof endpoint !== "string") return {ok: false, reason: "模型接口地址不能为空。"};
  const trimmed = endpoint.trim();
  if (!trimmed) return {ok: false, reason: "模型接口地址不能为空。"};
  let url;
  try { url = new URL(trimmed); } catch { return {ok: false, reason: "模型接口地址不是合法 URL。"}; }
  if (!url.hostname) return {ok: false, reason: "模型接口地址缺少主机名。"};
  if (url.search || url.hash) {
    return {ok: false, reason: "模型接口地址不能包含 query 参数或 hash 片段。"};
  }
  const pathname = url.pathname;
  if (!pathname || pathname === "/") {
    url.pathname = "/v1/chat/completions";
  } else if (/\/chat\/completions\/?$/.test(pathname)) {
    url.pathname = pathname.replace(/\/chat\/completions\/?$/, "/chat/completions");
  } else {
    url.pathname = pathname.replace(/\/+$/, "") + "/chat/completions";
  }
  return {ok: true, url: url.href};
}

/**
 * 从聊天端点推导探测用的 GET /models 端点（纯函数）。
 * @param {unknown} chatEndpoint
 * @returns {{ok:true, url:string}|{ok:false, reason:string}}
 */
export function modelsEndpointFrom(chatEndpoint) {
  const normalized = normalizeChatEndpoint(chatEndpoint);
  if (!normalized.ok) return normalized;
  return {ok: true, url: normalized.url.replace(/\/chat\/completions$/, "/models")};
}

/**
 * 统一错误工厂：code 为固定枚举，publicMessage 只含中文短句，不含密钥、端点与响应体。
 * @param {string} code LLM_CONFIG | LLM_TIMEOUT | LLM_HTTP_4XX | LLM_HTTP_5XX | LLM_NETWORK | LLM_BAD_RESPONSE
 * @param {string} message 中文短句
 * @returns {Error & {code:string, publicMessage:string}}
 */
const failure = (code, message) => Object.assign(new Error(message), {code, publicMessage: message});

const tokenCount = value => {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
};

/**
 * 校验密钥环境变量名；失败抛 LLM_CONFIG，错误信息只回显变量名，不回显任何密钥值。
 * @param {string} apiKeyEnv
 * @returns {string} 规范化后的环境变量名
 */
export function validateApiKeyEnv(apiKeyEnv) {
  const name = typeof apiKeyEnv === "string" ? apiKeyEnv.trim() : "";
  if (!name) throw failure("LLM_CONFIG", "模型密钥引用不能为空。");
  // denylist 先于前缀判断：系统变量不可能因为前缀规则放宽而被引用。
  if (DENIED_KEY_ENVS.has(name)) throw failure("LLM_CONFIG", "模型密钥引用不允许指向系统变量 " + name + "。");
  if (!API_KEY_ENV_PATTERN.test(name)) throw failure("LLM_CONFIG", "模型密钥引用必须匹配 CHATAI_KEY_ 前缀规则。");
  return name;
}

/**
 * 判断主机名是否属于本机 / 私网 / `.local` 字面量。
 * 说明：P1 只做字面量检查，不做 DNS 解析后的 IP 复检（防 rebinding 见 README 限制）。
 * @param {string} hostname
 * @returns {boolean}
 */
export function isPrivateHostname(hostname) {
  const host = String(hostname ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (LOCAL_HOSTS.has(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".localhost")) return true;
  return PRIVATE_IPV4.some(pattern => pattern.test(host));
}

/**
 * 校验端点：可解析、默认必须 HTTPS、默认拒绝本机与私网。
 * @param {string} endpoint
 * @param {{allowInsecureHttp?:boolean, allowPrivateHosts?:boolean}} [options]
 * @returns {URL}
 */
export function validateEndpoint(endpoint, {allowInsecureHttp = false, allowPrivateHosts = false} = {}) {
  let url;
  try { url = new URL(String(endpoint ?? "")); } catch { throw failure("LLM_CONFIG", "模型接口地址不是合法 URL。"); }
  if(url.username || url.password)throw failure("LLM_CONFIG","接口地址不能包含用户名或密码。");
  if (!url.hostname) throw failure("LLM_CONFIG", "模型接口地址缺少主机名。");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowInsecureHttp === true)) throw failure("LLM_CONFIG", "模型接口地址必须使用 HTTPS。");
  if (isPrivateHostname(url.hostname) && allowPrivateHosts !== true) throw failure("LLM_CONFIG", "模型接口地址不允许指向本机或内网。");
  return url;
}

/**
 * OpenAI 兼容聊天补全客户端。
 */
export class LlmClient {
  /**
   * @param {Object} options
   * @param {Function} [options.fetchImpl] 注入 fetch（默认 globalThis.fetch）
   * @param {() => number} [options.now] 注入时钟（用于耗时统计）
   * @param {(ms:number) => Promise<void>} [options.sleep] 注入等待（用于重试间隔，测试无需真实等待）
   * @param {(entry:{status:number|null, code:string|null, elapsedMs:number}) => void} [options.log] 可选日志钩子，只接收状态码、错误码与耗时
   * @param {string} options.endpoint 例如 https://api.example.com/v1/chat/completions
   * @param {string} options.model 模型 ID
   * @param {string} options.apiKeyEnv 密钥环境变量名（CHATAI_KEY_*）
   * @param {number} [options.temperature] 默认温度
   * @param {number} [options.maxOutputTokens] 默认输出上限
   * @param {number} [options.timeoutMs] 默认 30000
   * @param {boolean} [options.allowInsecureHttp] 显式允许 http:
   * @param {boolean} [options.allowPrivateHosts] 显式允许本机 / 私网
   */
  constructor(options = {}) {
    const {
      fetchImpl = globalThis.fetch,
      now = Date.now,
      sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
      log = () => {},
      timeoutMs = DEFAULT_TIMEOUT_MS,
      retryDelayMs = DEFAULT_RETRY_DELAY_MS,
      ...profile
    } = options || {};
    if (typeof fetchImpl !== "function") throw failure("LLM_CONFIG", "缺少可用的网络请求实现。");
    // 安全校验必须在创建 client 时立即完成，早于任何请求。
    this.apiKeyEnv = validateApiKeyEnv(profile.apiKeyEnv);
    const normalized = normalizeChatEndpoint(profile.endpoint);
    if (!normalized.ok) throw failure("LLM_CONFIG", normalized.reason);
    this.rawEndpoint = typeof profile.endpoint === "string" ? profile.endpoint.trim() : "";
    this.endpoint = validateEndpoint(normalized.url, {allowInsecureHttp: profile.allowInsecureHttp, allowPrivateHosts: profile.allowPrivateHosts}).href;
    this.model = typeof profile.model === "string" ? profile.model.trim() : "";
    if (!this.model) throw failure("LLM_CONFIG", "模型标识不能为空。");
    this.temperature = profile.temperature;
    this.maxOutputTokens = profile.maxOutputTokens;
    const timeout = Number(timeoutMs);
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;
    const retryDelay = Number(retryDelayMs);
    this.retryDelayMs = Number.isFinite(retryDelay) && retryDelay >= 0 ? retryDelay : DEFAULT_RETRY_DELAY_MS;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.log = log;
  }

  /**
   * 发起一次聊天补全；仅连接类失败重试 1 次（超时与 HTTP 状态不重试）。
   * @param {{messages?:Array<Object>, temperature?:number, maxOutputTokens?:number, signal?:AbortSignal}} [input]
   * @returns {Promise<{text:string, usage:{input:number, output:number}, model:string}>}
   */
  async complete({messages, temperature, maxOutputTokens, signal} = {}) {
    const apiKey = this._requireApiKey();
    const payload = {model: this.model, messages: Array.isArray(messages) ? messages : [], stream: false};
    const resolvedTemperature = temperature ?? this.temperature;
    if (resolvedTemperature !== undefined) payload.temperature = resolvedTemperature;
    const resolvedMaxTokens = maxOutputTokens ?? this.maxOutputTokens;
    if (resolvedMaxTokens !== undefined) payload.max_tokens = resolvedMaxTokens;
    const body = JSON.stringify(payload);
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this._request({apiKey, body, signal});
      } catch (error) {
        lastError = error;
        // 只有连接类失败值得重试；外部已取消时立即停止。
        if (error?.code !== "LLM_NETWORK" || signal?.aborted || attempt === MAX_ATTEMPTS) break;
        await this.sleep(this.retryDelayMs);
      }
    }
    throw lastError;
  }

  /**
   * 单次请求；超时与外部 signal 合并，任一 abort 都会中断在途请求。
   * @param {{apiKey:string, body:string, signal?:AbortSignal}} input
   */
  async _request({apiKey, body, signal}) {
    if (signal?.aborted) throw failure("LLM_NETWORK", "模型请求已取消。");
    const startedAt = this.now();
    let status = null;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {Authorization: "Bearer " + apiKey, "Content-Type": "application/json"},
        body,
        signal: requestSignal,
        redirect: "error"
      });
      status = Number(response?.status) || 0;
      if (!response?.ok) {
        if (status >= 400 && status < 500) throw Object.assign(failure("LLM_HTTP_4XX", "模型接口拒绝了本次请求。"), {status});
        throw Object.assign(failure("LLM_HTTP_5XX", "模型服务暂时不可用。"), {status});
      }
      let data;
      try { data = await response.json(); } catch { throw failure("LLM_BAD_RESPONSE", "模型返回的数据格式异常。"); }
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw failure("LLM_BAD_RESPONSE", "模型返回的数据格式异常。");
      this.log({status, code: null, elapsedMs: this.now() - startedAt});
      return {
        text: content,
        usage: {input: tokenCount(data?.usage?.prompt_tokens), output: tokenCount(data?.usage?.completion_tokens)},
        model: typeof data?.model === "string" && data.model ? data.model : this.model
      };
    } catch (error) {
      const classified = error?.code ? error
        : timeout.signal.aborted ? failure("LLM_TIMEOUT", "模型请求超时，请稍后重试。")
        : signal?.aborted ? failure("LLM_NETWORK", "模型请求已取消。")
        : failure("LLM_NETWORK", "模型网络请求失败，请稍后重试。");
      if (error?.cause?.code && /^[A-Z0-9_]{1,40}$/.test(error.cause.code)) classified.causeCode = error.cause.code;
      this.log({status, code: classified.code, elapsedMs: this.now() - startedAt});
      throw classified;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 只在调用时读取环境变量：缺失按 LLM_CONFIG 处理，错误信息不含任何密钥值。 */
  _requireApiKey() {
    const value = process.env?.[this.apiKeyEnv];
    if (typeof value !== "string" || !value.trim()) throw failure("LLM_CONFIG", "模型密钥未配置。");
    return value.trim();
  }
}

export default LlmClient;
