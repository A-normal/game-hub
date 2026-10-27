/**
 * @file packages/plugin/chat-ai/src/wizard.mjs
 * @description 模型档案分步配置向导（进程内内存状态，TTL 10 分钟，仅限私聊）。
 *              向导输入在 stage: "text" 阶段被完全消费，不进入 chat_messages。
 */

import {clearCatalogDraft} from "./catalog.mjs";
import {isSensitiveText} from "./session.mjs";
import {hasChatAdmin} from "./admin.mjs";
import {checkSingleProfile, validateApiKeyEnvName, validateChatEndpoint} from "./health.mjs";

const MODEL_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_MODEL_LENGTH = 128;
const WIZARD_TTL_MS = 10 * 60 * 1000; // 10 分钟

/** 进程内草稿 Map：userId -> {mode: 'create'|'update', step, targetId, draft, updatedAt} */
const drafts = new Map();
const wizardUser = event => [event.platform,event.botId,event.unifiedUserId].join(":");
let currentClock = Date.now;

/** 设置向导时钟（测试注入） */
export function setWizardClock(clock) {
  currentClock = typeof clock === "function" ? clock : Date.now;
}

/** 清除所有草稿（测试与停用时使用） */
export function clearAllDrafts() {
  drafts.clear();
  currentClock = Date.now;
}

/** 清除指定用户草稿 */
export function clearDraft(userId) {
  drafts.delete(String(userId));
}

/**
 * 获取活跃草稿（自动处理 TTL 过期）。
 * @param {string} userId
 * @param {()=>number} [clock]
 * @returns {Object|null}
 */
export function getActiveDraft(userId, clock = currentClock) {
  const id = String(userId ?? "").trim();
  if (!id) return null;
  const entry = drafts.get(id);
  if (!entry) return null;
  const now = typeof clock === "function" ? clock() : Date.now();
  if (now - entry.updatedAt > WIZARD_TTL_MS) {
    drafts.delete(id);
    return null;
  }
  return entry;
}

/**
 * 判断事件是否命中向导输入路由（必须是私聊且有未过期草稿）。
 * @param {Object} event
 * @param {()=>number} [clock]
 * @returns {boolean}
 */
export function isWizardEvent(event, clock = currentClock) {
  if (!event || event.isGroup) return false;
  return Boolean(getActiveDraft(wizardUser(event), clock));
}

/**
 * stage: "text" 路由：消费向导输入。
 * @param {Object} ctx
 * @returns {Promise<{status:"HANDLED"|"DENIED"}>}
 */
export async function handleWizardInput(ctx) {
  const event = ctx.event;
  const userId = wizardUser(event);
  const clock = typeof ctx.services?.now === "function" ? ctx.services.now : Date.now;
  const entry = getActiveDraft(userId, clock);
  if (!entry) return {status: "NOT_MATCHED"};

  // 每一跳重新校验管理员权限：若中途被撤销则终止向导
  if (!hasChatAdmin(event, {vault: ctx.vault, dispatcher: ctx.dispatcher})) {
    drafts.delete(userId);
    await event.reply("【权限拒绝】管理员权限已失效，模型配置向导已终止。");
    return {status: "DENIED"};
  }

  const raw = String(event.cleanText ?? "").trim();
  const now = clock();
  if(isSensitiveText(raw)) {await event.reply("输入包含凭据或可执行消息段，未保存。请填写环境变量引用，不要发送密钥值。");return {status:"HANDLED"};}

  // 取消：任何步骤有效
  if (raw === "取消") {
    drafts.delete(userId);
    await event.reply("已取消模型配置向导。");
    return {status: "HANDLED"};
  }

  if (entry.mode === "create") {
    await handleCreateStep(ctx, entry, raw, now);
  } else if (entry.mode === "update") {
    await handleUpdateStep(ctx, entry, raw, now);
  }

  return {status: "HANDLED"};
}

async function handleCreateStep(ctx, entry, input, now) {
  const event = ctx.event;
  const userId = wizardUser(event);
  const store = ctx.services?.store;

  switch (entry.step) {
    case "id": {
      if (!MODEL_ID_PATTERN.test(input)) {
        await event.reply("档案别名格式不正确（必须小写字母开头，限 1-32 位小写字母、数字、下划线或短横线，例如 main）。\n请重新输入模型档案别名：");
        entry.updatedAt = now;
        return;
      }
      if (store?.getModel?.(input)) {
        await event.reply("模型档案别名 " + input + " 已存在，请换一个别名：");
        entry.updatedAt = now;
        return;
      }
      entry.draft.id = input;
      entry.step = "endpoint";
      entry.updatedAt = now;
      await event.reply(
        "【模型新增向导】第 2/4 步：接口地址\n" +
        "请输入 OpenAI 兼容接口地址（支持 base URL，例如 https://api.example.com/v1）：\n" +
        "（回复「取消」可退出向导）"
      );
      break;
    }
    case "endpoint": {
      const epCheck = validateChatEndpoint(input);
      if (!epCheck.ok) {
        await event.reply("接口地址不合法：" + epCheck.reason + "\n请重新输入接口地址：");
        entry.updatedAt = now;
        return;
      }
      entry.draft.endpoint = input;
      entry.step = "model";
      entry.updatedAt = now;
      await event.reply(
        "【模型新增向导】第 3/4 步：模型标识\n" +
        "请输入模型 ID（例如 your-model-id）：\n" +
        "（回复「取消」可退出向导）"
      );
      break;
    }
    case "model": {
      if (!input || input.length > MAX_MODEL_LENGTH) {
        await event.reply("模型 ID 不能为空且不能超过 " + MAX_MODEL_LENGTH + " 字符。\n请重新输入模型 ID：");
        entry.updatedAt = now;
        return;
      }
      entry.draft.model = input;
      entry.step = "apiKeyEnv";
      entry.updatedAt = now;
      await event.reply(
        "【模型新增向导】第 4/4 步：密钥环境变量名\n" +
        "请输入密钥环境变量名（必须以 CHATAI_KEY_ 开头且不得指向系统变量，例如 CHATAI_KEY_MAIN）：\n" +
        "（回复「取消」可退出向导）"
      );
      break;
    }
    case "apiKeyEnv": {
      const keyCheck = validateApiKeyEnvName(input);
      if (!keyCheck.ok) {
        await event.reply("密钥环境变量名不合法：" + keyCheck.reason + "\n请重新输入密钥环境变量名：");
        entry.updatedAt = now;
        return;
      }
      entry.draft.apiKeyEnv = keyCheck.name;
      entry.step = "confirm";
      entry.updatedAt = now;
      await event.reply(
        "【模型新增向导】配置摘要\n" +
        "· 别名: " + entry.draft.id + "\n" +
        "· 接口: " + entry.draft.endpoint + "\n" +
        "· 模型: " + entry.draft.model + "\n" +
        "· 密钥: CHATAI_KEY_***\n\n" +
        "回复「确认」保存；「确认并使用」保存并用于本会话；「取消」丢弃；「重来」重填。"
      );
      break;
    }
    case "confirm": {
      if (input === "确认" || input === "确认并使用") {
        store?.saveModel?.({
          id: entry.draft.id,
          label: entry.draft.id,
          endpoint: entry.draft.endpoint,
          model: entry.draft.model,
          apiKeyEnv: entry.draft.apiKeyEnv
        });
        drafts.delete(userId);
        if (input === "确认并使用" && process.env[entry.draft.apiKeyEnv]?.trim()) {
          const {sessionDataOf} = await import("./session.mjs");
          const data=sessionDataOf(event); store.ensureSession(data); store.setModelProfile(data.sessionId,entry.draft.id);
        }
        await event.reply(
          "【模型新增成功】已保存档案 " + entry.draft.id + "。\n" +
          "密钥不入库。立即使用：" + ctx.commands.format({routeId:"modelUse",args:[entry.draft.id]}) + "；检测仅验证接口连通性。"
        );
      } else if (input === "重来") {
        entry.draft = {};
        entry.step = "id";
        entry.updatedAt = now;
        await event.reply(
          "已清空重填。\n【模型新增向导】第 1/4 步：别名\n" +
          "请输入模型档案别名（例如 main）："
        );
      } else {
        await event.reply("请输入「确认」保存配置，「重来」重新填写，或「取消」退出向导：");
        entry.updatedAt = now;
      }
      break;
    }
  }
}

async function handleUpdateStep(ctx, entry, input, now) {
  const event = ctx.event;
  const userId = wizardUser(event);
  const store = ctx.services?.store;
  const targetId = entry.targetId;

  switch (entry.step) {
    case "endpoint": {
      if (input !== "跳过") {
        const epCheck = validateChatEndpoint(input);
        if (!epCheck.ok) {
          await event.reply("接口地址不合法：" + epCheck.reason + "\n请重新输入接口地址（或回复「跳过」保留原值）：");
          entry.updatedAt = now;
          return;
        }
        entry.draft.endpoint = input;
      }
      entry.step = "model";
      entry.updatedAt = now;
      await event.reply(
        "【模型修改向导】档案: " + targetId + "\n第 2/3 步：模型标识\n" +
        "当前值: " + entry.draft.model + "\n" +
        "请输入新的模型标识（回复「跳过」保留原值，回复「取消」退出）："
      );
      break;
    }
    case "model": {
      if (input !== "跳过") {
        if (!input || input.length > MAX_MODEL_LENGTH) {
          await event.reply("模型 ID 不能为空且不能超过 " + MAX_MODEL_LENGTH + " 字符。\n请重新输入（或回复「跳过」保留原值）：");
          entry.updatedAt = now;
          return;
        }
        entry.draft.model = input;
      }
      entry.step = "apiKeyEnv";
      entry.updatedAt = now;
      await event.reply(
        "【模型修改向导】档案: " + targetId + "\n第 3/3 步：密钥环境变量名\n" +
        "当前值: CHATAI_KEY_***\n" +
        "请输入新的密钥环境变量名（回复「跳过」保留原值，回复「取消」退出）："
      );
      break;
    }
    case "apiKeyEnv": {
      if (input !== "跳过") {
        const keyCheck = validateApiKeyEnvName(input);
        if (!keyCheck.ok) {
          await event.reply("密钥环境变量名不合法：" + keyCheck.reason + "\n请重新输入（或回复「跳过」保留原值）：");
          entry.updatedAt = now;
          return;
        }
        entry.draft.apiKeyEnv = keyCheck.name;
      }
      entry.step = "confirm";
      entry.updatedAt = now;
      await event.reply(
        "【模型修改向导】配置摘要\n" +
        "· 别名: " + targetId + "\n" +
        "· 接口: " + entry.draft.endpoint + "\n" +
        "· 模型: " + entry.draft.model + "\n" +
        "· 密钥: CHATAI_KEY_***\n\n" +
        "回复「确认」保存修改，回复「取消」丢弃，回复「重来」重新填写。"
      );
      break;
    }
    case "confirm": {
      if (input === "确认") {
        store?.saveModel?.(entry.draft);
        drafts.delete(userId);
        await event.reply("【模型修改成功】档案 " + targetId + " 已更新保存。");
      } else if (input === "重来") {
        const original = store?.getModel?.(targetId);
        entry.draft = original ? {...original} : {};
        entry.step = "endpoint";
        entry.updatedAt = now;
        await event.reply(
          "已清空重填。\n【模型修改向导】档案: " + targetId + "\n第 1/3 步：接口地址\n" +
          "当前值: " + (entry.draft.endpoint || "无") + "\n" +
          "请输入新的接口地址（回复「跳过」保留原值）："
        );
      } else {
        await event.reply("请输入「确认」保存修改，「重来」重新填写，或「取消」退出向导：");
        entry.updatedAt = now;
      }
      break;
    }
  }
}

/**
 * 命令：!模型新增
 */
export async function modelAdd(ctx) {
  clearCatalogDraft(ctx.event);
  const event = ctx.event;
  if (event.isGroup) {
    await event.reply("模型配置向导仅支持私聊发起。");
    return;
  }
  const userId = wizardUser(event);
  const clock = typeof ctx.services?.now === "function" ? ctx.services.now : Date.now;
  drafts.set(userId, {
    mode: "create",
    step: "id",
    draft: {},
    updatedAt: clock()
  });
  await event.reply(
    "【模型新增向导】第 1/4 步：档案别名\n" +
    "请输入模型档案别名（小写字母开头，限 1-32 位小写字母、数字、下划线或短横线，例如 main）：\n" +
    "（回复「取消」可随时退出向导）"
  );
}

/**
 * 命令：!模型修改 <别名>
 */
export async function modelSet(ctx) {
  clearCatalogDraft(ctx.event);
  const event = ctx.event;
  if (event.isGroup) {
    await event.reply("模型修改向导仅支持私聊发起。");
    return;
  }
  const alias = (ctx.args || [])[0];
  if (!alias) {
    await event.reply("用法: " + ctx.commands.format({routeId: "modelSet", args: ["<别名>"]}));
    return;
  }
  const store = ctx.services?.store;
  const existing = store?.getModel?.(alias);
  if (!existing) {
    await event.reply("未找到模型档案 " + alias + "。");
    return;
  }
  const userId = wizardUser(event);
  const clock = typeof ctx.services?.now === "function" ? ctx.services.now : Date.now;
  drafts.set(userId, {
    mode: "update",
    step: "endpoint",
    targetId: alias,
    draft: {...existing},
    updatedAt: clock()
  });
  await event.reply(
    "【模型修改向导】档案: " + alias + "\n第 1/3 步：接口地址\n" +
    "当前值: " + existing.endpoint + "\n" +
    "请输入新的接口地址（回复「跳过」保留原值，回复「取消」退出向导）："
  );
}

/**
 * 命令：!模型删除 <别名>
 */
export async function modelRemove(ctx) {
  const alias = (ctx.args || [])[0];
  if (!alias) {
    await ctx.event.reply("用法: " + ctx.commands.format({routeId: "modelRemove", args: ["<别名>"]}));
    return;
  }
  const store = ctx.services?.store;
  if (!store?.deleteModel?.(alias)) {
    await ctx.event.reply("未找到模型档案 " + alias + "。");
    return;
  }
  if (ctx.services.health?.defaultProfileId === alias) ctx.services.health.defaultProfileId="";
  await ctx.event.reply("已删除模型档案 " + alias + "。关联会话已改为跟随默认；若默认也被删除，请重新选择默认模型。");
}

/**
 * 命令：!模型列表
 */
export async function modelList(ctx) {
  const services = ctx.services;
  const store = services?.store;
  const models = store?.listModels?.() || [];
  if (!models.length) {
    await ctx.event.reply(
      "目前没有模型档案。管理员可在私聊使用 " +
      ctx.commands.format({routeId: "modelAdd"}) +
      " 通过分步向导新增档案。"
    );
    return;
  }
  const defaultId = store.getSetting("defaultModel") ?? (services?.health?.defaultProfileId || services?.config?.model?.defaultProfileId || "");
  const healthProfiles = new Map((services?.health?.profiles || []).map(p => [p.id, p]));
  const lines = ["【模型档案列表】共 " + models.length + " 个："];
  lines.push("别名 | 默认 | 健康状态 | 模型 ID | 接口地址");
  for (const m of models) {
    const isDef = m.id === defaultId ? "是" : "否";
    const hp = healthProfiles.get(m.id);
    const healthStatus = hp ? hp.status : "未检测";
    lines.push(m.id + " | " + isDef + " | " + healthStatus + " | " + m.model + " | " + m.endpoint);
  }
  lines.push("密钥: CHATAI_KEY_***（仅存环境变量名，不回显）");
  await ctx.event.reply(lines.join("\n"));
}

/**
 * 命令：!模型检测 [别名]
 */
export async function modelCheck(ctx) {
  const services = ctx.services;
  const store = services?.store;
  const alias = (ctx.args || [])[0];
  let targets = [];
  if (alias) {
    const found = store?.getModel?.(alias);
    if (!found) {
      await ctx.event.reply("未找到模型档案 " + alias + "。");
      return;
    }
    targets = [found];
  } else {
    targets = store?.listModels?.() || [];
    if (!targets.length) {
      await ctx.event.reply("目前没有模型档案可供检测。");
      return;
    }
  }

  const timeoutMs = Number(services?.config?.healthCheck?.timeoutMs) || 5000;
  const fetchImpl = services?.fetchImpl || globalThis.fetch;
  const results = [];

  for (const m of targets) {
    const res = await checkSingleProfile(m, {probe: true, timeoutMs, fetchImpl});
    let conclusion = res.status;
    if (res.status === "未确认") {
      conclusion = (res.reason && (res.reason.includes("超时") || res.reason.includes("网络"))) ? "网络失败" : "未确认";
    }
    results.push("· " + m.id + ": " + conclusion + " (" + res.reason + ")");
  }

  await ctx.event.reply("【模型检测结果】\n" + results.join("\n"));
}

export default {
  clearAllDrafts,
  clearDraft,
  getActiveDraft,
  isWizardEvent,
  handleWizardInput,
  modelAdd,
  modelSet,
  modelRemove,
  modelList,
  modelCheck
};
