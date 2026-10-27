/** Model-ID editing drafts. Service address/key editing belongs to the connection catalog. */
import {clearCatalogDraft} from "./catalog.mjs";
import {isSensitiveText} from "./session.mjs";
import {hasChatAdmin} from "./admin.mjs";
import {checkSingleProfile} from "./health.mjs";
export {modelAdd, modelList} from "./catalog.mjs";

const drafts = new Map();
const WIZARD_TTL_MS = 10 * 60 * 1000;
const wizardUser = event => [event.platform,event.botId,event.unifiedUserId].join(":");
let currentClock = Date.now;
export function setWizardClock(clock) { currentClock = typeof clock === "function" ? clock : Date.now; }
export function clearAllDrafts() { drafts.clear(); currentClock = Date.now; }
export function clearDraft(userId) { drafts.delete(String(userId)); }
export function getActiveDraft(userId, clock = currentClock) {
  const entry = drafts.get(String(userId));
  if (entry && clock() - entry.updatedAt > WIZARD_TTL_MS) { drafts.delete(String(userId)); return null; }
  return entry || null;
}
export function isWizardEvent(event, clock = currentClock) {
  return Boolean(event && !event.isGroup && getActiveDraft(wizardUser(event), clock));
}
const prompt = (ctx, entry) => ctx.event.reply("【模型修改】" + entry.targetId + "\n当前上游模型 ID：" + entry.originalModel + "\n请输入新的上游模型 ID；回复「跳过」保留，回复「取消」退出。\n服务地址与密钥引用请使用：" + ctx.commands.format({routeId:"connectionEdit",args:[entry.connectionId]}));

export async function modelSet(ctx) {
  if (ctx.event.isGroup) { await ctx.event.reply("模型修改请在私聊进行。"); return; }
  const input = ctx.args[0];
  if (!input) return ctx.event.reply("用法：" + ctx.commands.format({routeId:"modelSet",args:["<模型名称或ID>"]}));
  const rows = ctx.services.store.listModels();
  const matches = rows.filter(row => row.label === input);
  const row = rows.find(row => row.id === input) || (matches.length === 1 ? matches[0] : null);
  if (!row) return ctx.event.reply("未找到唯一的模型名称或ID，未修改配置。");
  clearCatalogDraft(ctx.event);
  const entry = {targetId:row.id,connectionId:row.connectionId,originalModel:row.model,step:"model",updatedAt:(ctx.services.now || Date.now)()};
  drafts.set(wizardUser(ctx.event),entry);
  return prompt(ctx,entry);
}

export async function handleWizardInput(ctx) {
  const key = wizardUser(ctx.event), clock = ctx.services.now || Date.now;
  const entry = getActiveDraft(key,clock);
  if (!entry) return {status:"NOT_MATCHED"};
  if (!hasChatAdmin(ctx.event,{vault:ctx.vault,dispatcher:ctx.dispatcher})) {
    drafts.delete(key); await ctx.event.reply("管理员权限已失效，模型修改已终止。"); return {status:"DENIED"};
  }
  const raw = String(ctx.event.cleanText || "").trim();
  if (raw === "取消") { drafts.delete(key); await ctx.event.reply("已取消模型修改。"); return; }
  if (isSensitiveText(raw)) return ctx.event.reply("输入包含凭据，未保存。此处只填写上游模型 ID。");
  entry.updatedAt = clock();
  if (raw === "重来") { entry.step="model"; delete entry.model; return prompt(ctx,entry); }
  if (entry.step === "model") {
    if (!raw || raw.length > 128 || /[\x00-\x1f]/.test(raw)) return ctx.event.reply("模型 ID 应为1至128个字符。");
    entry.model = raw === "跳过" ? entry.originalModel : raw;
    entry.step = "confirm";
    return ctx.event.reply("【模型修改摘要】\n上游模型 ID：" + entry.model + "\n仅修改此模型，服务连接与参数保持不变。回复「确认」保存、「重来」重填或「取消」。");
  }
  if (raw !== "确认") return ctx.event.reply("回复「确认」保存、「重来」重填或「取消」。");
  const latest = ctx.services.store.getModel(entry.targetId);
  if (!latest || latest.model !== entry.originalModel || latest.connectionId !== entry.connectionId) {
    drafts.delete(key); return ctx.event.reply("模型已被删除或修改，本次未保存，请重新发起。");
  }
  // Re-read all other fields so concurrent connection/parameter edits cannot be overwritten.
  ctx.services.store.saveModel({...latest,model:entry.model});
  drafts.delete(key);
  await ctx.event.reply("模型修改成功；服务连接与其他模型保持不变。");
}

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
