/**
 * @file packages/plugin/chat-ai/src/health.mjs
 * @description 启动健康检查与现场模型探测（GET /models）。
 *              严格遵循无外部依赖约定；fetchImpl 与 now 均可注入。
 */

const API_KEY_ENV_PATTERN = /^CHATAI_KEY_[A-Z0-9_]{1,56}$/;
const DENIED_KEY_ENVS = new Set(["TELEGRAM_BOT_API_TOKEN", "TELEGRAM_BOT_API_HTTPS_PROXY_URL", "NAPCAT_TO_GAMEHUB_CONNECTION_TOKEN", "GAMEHUB_ADMIN_REGISTRATION_TOKEN", "CHATAI_ADMIN_REGISTRATION_TOKEN", "GAMEHUB_TOKEN", "CHATAI_ADMIN_TOKEN", "VAULT_SECRET", "ACCESS_TOKEN", "MASTER_QQ", "GAMEHUB_ADMIN_USERS"]);
const PRIVATE_IPV4 = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./, /^127\./];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/**
 * 校验接口地址（纯函数）。
 * @param {string} endpoint
 * @returns {{ok:true, url:string}|{ok:false, reason:string}}
 */
export function validateChatEndpoint(endpoint) {
  if (typeof endpoint !== "string") return {ok: false, reason: "模型接口地址不能为空。"};
  const trimmed = endpoint.trim();
  if (!trimmed) return {ok: false, reason: "模型接口地址不能为空。"};
  let url;
  try { url = new URL(trimmed); } catch { return {ok: false, reason: "模型接口地址不是合法 URL。"}; }
  if(url.username || url.password)return {ok:false,reason:"接口地址不能包含用户名或密码。"};
  if (!url.hostname) return {ok: false, reason: "模型接口地址缺少主机名。"};
  if (url.search || url.hash) return {ok: false, reason: "模型接口地址不能包含 query 参数或 hash 片段。"};
  if (url.protocol !== "https:") return {ok: false, reason: "模型接口地址必须使用 HTTPS。"};
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (LOCAL_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".localhost") || PRIVATE_IPV4.some(pattern => pattern.test(host))) {
    return {ok: false, reason: "模型接口地址不允许指向本机或内网。"};
  }
  let pathname = url.pathname;
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
 * 校验密钥引用（纯函数）。
 * @param {string} apiKeyEnv
 * @returns {{ok:true, name:string}|{ok:false, reason:string}}
 */
export function validateApiKeyEnvName(apiKeyEnv) {
  const name = typeof apiKeyEnv === "string" ? apiKeyEnv.trim() : "";
  if (!name) return {ok: false, reason: "密钥环境变量名不能为空。"};
  if (DENIED_KEY_ENVS.has(name) || !API_KEY_ENV_PATTERN.test(name)) {
    return {ok: false, reason: "密钥引用必须匹配 CHATAI_KEY_ 前缀规则且不得指向系统变量。"};
  }
  return {ok: true, name};
}

/**
 * 单档案健康探测（纯函数 / 异步网络）。
 * @param {Object} profile {id, endpoint, model, apiKeyEnv}
 * @param {Object} [options]
 * @param {boolean} [options.probe=true]
 * @param {number} [options.timeoutMs=5000]
 * @param {Function} [options.fetchImpl]
 * @returns {Promise<{id:string, status:string, reason:string, usable:boolean}>}
 */
export async function checkSingleProfile(profile, {probe = true, timeoutMs = 5000, fetchImpl = globalThis.fetch} = {}) {
  const id = profile?.id || "unknown";
  const epCheck = validateChatEndpoint(profile?.endpoint);
  if (!epCheck.ok) {
    return {id, status: "配置错误", reason: epCheck.reason, usable: false};
  }
  const keyEnvCheck = validateApiKeyEnvName(profile?.apiKeyEnv);
  if (!keyEnvCheck.ok) {
    return {id, status: "配置错误", reason: keyEnvCheck.reason, usable: false};
  }
  const envVal = process.env?.[profile.apiKeyEnv];
  if (typeof envVal !== "string" || !envVal.trim()) {
    return {id, status: "密钥无效", reason: "环境变量 " + profile.apiKeyEnv + " 未配置或为空", usable: false};
  }

  if (probe !== true) {
    return {id, status: "可用", reason: "静态校验通过", usable: true};
  }

  const modelsUrl = epCheck.url.replace(/\/chat\/completions$/, "/models");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(modelsUrl, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + envVal.trim()
      },
      redirect: "error",
      signal: controller.signal
    });
    const status = Number(res?.status) || 0;
    if (status >= 200 && status < 300) {
      try {
        const body=await res.json();
        if(!Array.isArray(body?.data))return {id,status:"未确认",reason:"HTTP "+status+"，不是标准模型列表；生成未验证",usable:true};
        return {id,status:"可用",reason:"模型列表 HTTP "+status+"；生成未验证",usable:true};
      } catch {return {id,status:"未确认",reason:"模型列表响应无法解析；生成未验证",usable:true};}
    }
    if (status === 401 || status === 403) {
      return {id, status: "密钥无效", reason: "HTTP " + status, usable: false};
    }
    // 其它 4xx/5xx: 视为未确认，仍算可用
    return {id, status: "未确认", reason: "HTTP " + status, usable: true};
  } catch (error) {
    clearTimeout(timer);
    const isTimeout = controller.signal.aborted || error?.name === "AbortError";
    // 网络/超时: 视为未确认，仍算可用（避免开机抖动拖垮插件）
    return {id, status: "未确认", reason: isTimeout ? "探测超时" : "网络失败", usable: true};
  } finally { clearTimeout(timer); }
}

/**
 * 启动健康检查：只在 start() 执行，探测失败绝不抛。
 * @param {Object} options
 * @param {Object} options.store
 * @param {Object} options.config
 * @param {Object} options.log
 * @param {Function} [options.fetchImpl]
 * @param {()=>number} [options.now]
 * @returns {Promise<{checkedAt:number, defaultProfileId:string, profiles:Array<Object>}>}
 */
export async function runStartupHealthCheck({store, config, log, fetchImpl = globalThis.fetch, now = Date.now}) {
  const models = typeof store?.listModels === "function" ? store.listModels() : [];
  const probe = config?.healthCheck?.probe !== false;
  const timeoutMs = Number(config?.healthCheck?.timeoutMs) || 5000;
  const profiles = [];

  const probes=new Map();
  for (const m of models) {
    try {
      const connectionKey=m.endpoint+"\n"+m.apiKeyEnv;
      if(!probes.has(connectionKey))probes.set(connectionKey,checkSingleProfile(m,{probe,timeoutMs,fetchImpl}));
      const res = {...await probes.get(connectionKey),id:m.id};
      profiles.push(res);
      log?.info?.("chat-ai 健康检查 档案 " + res.id + " " + res.status + " " + (res.reason || ""));
    } catch {
      profiles.push({id: m.id, status: "未确认", reason: "检查异常", usable: true});
      log?.info?.("chat-ai 健康检查 档案 " + m.id + " 未确认 检查异常");
    }
  }

  const usableMap = new Map(profiles.map(p => [p.id, p.usable]));
  let defaultProfileId = "";
  const configuredDefault = store.getSetting?.("defaultModel") || config?.model?.defaultProfileId;

  if (configuredDefault && usableMap.get(configuredDefault) === true) {
    defaultProfileId = configuredDefault;
  } else {
    // 按创建时间升序取第一个可用的档案
    const firstUsable = models.find(m => usableMap.get(m.id) === true);
    if (firstUsable) defaultProfileId = firstUsable.id;
  }

  if (defaultProfileId) {
    log?.info?.("chat-ai 默认模型档案 " + defaultProfileId);
  } else {
    log?.error?.("chat-ai 没有可用的模型档案，所有会话消息将提示管理员配置");
  }

  return {
    checkedAt: now(),
    defaultProfileId,
    profiles
  };
}

export default {
  validateChatEndpoint,
  validateApiKeyEnvName,
  checkSingleProfile,
  runStartupHealthCheck
};
