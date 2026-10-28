/**
 * @file packages/plugin/chat-ai/src/index.mjs
 * @description chat-ai 插件入口：严格 configSchema、配置归一化、manifest 与 store 装配。
 *              导入与 createModule 都不发网络请求；建表发生在 ChatStore 构造里（即 createModule 内）。
 */

import manifest from "./manifest.mjs";
import {clearCatalog} from "./catalog.mjs";
import {clearInputs} from "./input.mjs";
import {createScheduler} from "./features.mjs";
import {createReplyEngine} from "./reply.mjs";
import {ChatStore} from "./store.mjs";
import {createLogger} from "./log.mjs";
import {runStartupHealthCheck} from "./health.mjs";
import {clearAllDrafts, setWizardClock} from "./wizard.mjs";

export {manifest};
export {ChatStore} from "./store.mjs";
export {createLogger} from "./log.mjs";
export {createReplyEngine} from "./reply.mjs";

/** 严格 JSON Schema 子集：只使用 type/required/properties/additionalProperties/enum/minimum/maximum/minLength/maxLength/pattern/items/maxItems。 */
export const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    debug: {type: "boolean"},
    policy: {
      type: "object",
      additionalProperties: false,
      properties: {
        groupDefault: {type: "string", enum: ["off", "mention", "all"]},
        privateDefault: {type: "string", enum: ["off", "all"]}
      }
    },
    retention: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxMessages: {type: "number", minimum: 4, maximum: 200},
        maxCharsPerMessage: {type: "number", minimum: 50, maximum: 4000}
      }
    },
    model: {
      type: "object",
      additionalProperties: false,
      properties: {
        defaultProfileId: {type: "string", maxLength: 32},
        temperature: {type: "number", minimum: 0, maximum: 2},
        maxOutputTokens: {type: "number", minimum: 1, maximum: 4096},
        maxContextChars: {type:"number",minimum:2000,maximum:80000},
        timeoutMs: {type: "number", minimum: 1000, maximum: 120000}
      }
    },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxCharsOut: {type: "number", minimum: 50, maximum: 2000},
        queuePerSession: {type: "number", minimum: 1, maximum: 10},
        requestsPerDay: {type: "number", minimum: 1, maximum: 10000}
      }
    },
    healthCheck: {
      type: "object",
      additionalProperties: false,
      properties: {
        probe: {type: "boolean"},
        timeoutMs: {type: "number", minimum: 1000, maximum: 30000}
      }
    }
  }
};

const pickNumber = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
};
const pickEnum = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const section = (value, key) => (value && typeof value === "object" && value[key] && typeof value[key] === "object" ? value[key] : {});

/**
 * 配置归一化：缺省值补齐、越界值回退默认（loader 会先用 configSchema 拒绝越界）。
 * @param {Object} [raw]
 * @returns {{debug:boolean, policy:Object, retention:Object, model:Object, limits:Object}}
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const policy = section(source, "policy");
  const retention = section(source, "retention");
  const model = section(source, "model");
  const limits = section(source, "limits");
  const healthCheck = section(source, "healthCheck");
  return {
    debug: source.debug === true,
    policy: {
      groupDefault: pickEnum(policy.groupDefault, ["off", "mention", "all"], "mention"),
      privateDefault: pickEnum(policy.privateDefault, ["off", "all"], "all")
    },
    retention: {
      maxMessages: pickNumber(retention.maxMessages, 20, 4, 200),
      maxCharsPerMessage: pickNumber(retention.maxCharsPerMessage, 1000, 50, 4000)
    },
    model: {
      defaultProfileId: typeof model.defaultProfileId === "string" ? model.defaultProfileId.slice(0, 32) : "",
      temperature: pickNumber(model.temperature, 0.8, 0, 2),
      maxOutputTokens: pickNumber(model.maxOutputTokens, 300, 1, 4096),
      maxContextChars: pickNumber(model.maxContextChars,12000,2000,80000),
      timeoutMs: pickNumber(model.timeoutMs, 30000, 1000, 120000)
    },
    limits: {
      maxCharsOut: pickNumber(limits.maxCharsOut, 600, 50, 2000),
      queuePerSession: pickNumber(limits.queuePerSession, 3, 1, 10),
      requestsPerDay: pickNumber(limits.requestsPerDay, 300, 1, 10000)
    },
    healthCheck: {
      probe: healthCheck.probe !== false,
      timeoutMs: pickNumber(healthCheck.timeoutMs, 5000, 1000, 30000)
    }
  };
}

export const DEFAULT_CONFIG = Object.freeze(normalizeConfig({}));

/**
 * 装配插件实例。
 * start() 执行一次启动健康检查并固定默认模型（探测失败不抛）；stop() 终止在途请求并清理草稿。
 * @param {{config?:Object, vault:Object, dispatcher?:Object, now?:() => number, fetchImpl?:Function}} options
 * @returns {Object}
 */
export function createModule({config = {}, vault, dispatcher = null, now = Date.now, random = Math.random, fetchImpl = globalThis.fetch} = {}) {
  const normalized = normalizeConfig(config);
  const clock = typeof now === "function" ? now : Date.now;
  setWizardClock(clock);
  const store = new ChatStore(vault, {now: clock});
  const log = createLogger(normalized);
  const services = {
    store,
    config: normalized,
    log,
    dispatcher,
    now: clock,
    random,
    fetchImpl,
    health: {
      checkedAt: null,
      defaultProfileId: normalized.model.defaultProfileId || "",
      profiles: []
    }
  };
  const engine = createReplyEngine({
    store,
    config: normalized,
    log,
    dispatcher,
    now: clock,
    getHealth: () => services.health,
    onInterjection: (id,reason) => { store.setOption(id,"interjectionLast",{at:clock(),reason}); log.debug(`插话 reason=${reason}`); }
  });
  services.engine = engine;
  services.scheduler = createScheduler(services);
  return {
    ...manifest,
    config: normalized,
    services,
    start: async () => {
      try {
        const health = await runStartupHealthCheck({
          store,
          config: normalized,
          log,
          fetchImpl,
          now: clock
        });
        services.health = health;
        services.scheduler.start();
      } catch (err) {
        log?.warn?.("chat-ai 健康检查执行异常: " + (err?.message || ""));
      }
    },
    stop: async () => {
      clearInputs(services);
      clearAllDrafts();
      clearCatalog();
      services.scheduler.stop();
      await engine.stop();
    }
  };
}

export default manifest;
