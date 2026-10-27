/**
 * @file packages/provider/llm/src/index.mjs
 * @description OpenAI 兼容大语言模型 provider 模块入口：configSchema + provider 工厂 + createModule。
 *              导入与 createModule 均无网络副作用。
 */

import {LlmClient} from "./client.mjs";

export {
  LlmClient,
  normalizeChatEndpoint,
  modelsEndpointFrom,
  validateApiKeyEnv,
  validateEndpoint,
  isPrivateHostname,
  API_KEY_ENV_PATTERN,
  API_KEY_ENV_DENYLIST
} from "./client.mjs";

/** 严格 JSON Schema 子集：只使用 type/required/properties/additionalProperties/enum/minimum/maximum/minLength/maxLength/pattern/items/maxItems。 */
export const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    timeoutMs: {type: "number", minimum: 1000, maximum: 120000},
    allowInsecureHttp: {type: "boolean"},
    allowPrivateHosts: {type: "boolean"}
  }
};

export class LlmProvider {
  /** @param {Object} [config] 模块级配置（loader 按 configSchema 校验后注入） */
  constructor(config = {}) {
    this.id = "llm";
    this.kind = "provider";
    this.contractVersion = 1;
    this.capabilities = ["chat"];
    this.name = "通用大语言模型";
    this.config = {...config};
  }

  /**
   * 为一个模型档案创建专用客户端；档案里的安全开关与超时覆盖模块级默认值。
   * @param {Object} [profile] {endpoint, model, apiKeyEnv, temperature, maxOutputTokens, timeoutMs, allowInsecureHttp, allowPrivateHosts}
   * @returns {LlmClient}
   */
  createClient(profile = {}) {
    const config = this.config;
    return new LlmClient({
      timeoutMs: config.timeoutMs,
      allowInsecureHttp: config.allowInsecureHttp,
      allowPrivateHosts: config.allowPrivateHosts,
      ...profile
    });
  }
}

export default LlmProvider;

/** 加载器入口：只构造 provider 实例，不发请求。 */
export function createModule({config = {}} = {}) { return new LlmProvider(config); }
