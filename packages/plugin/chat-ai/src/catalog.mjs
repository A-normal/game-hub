import crypto from "node:crypto";
import {clearDraft} from "./wizard.mjs";
import {parseCharacterCard} from "./character.mjs";
import {hasChatAdmin} from "./admin.mjs";
import {sessionDataOf,clipText,isSensitiveText,draftKeyOf} from "./session.mjs";
import {validateChatEndpoint,validateApiKeyEnvName} from "./health.mjs";
import {configurationSettings} from "./preferences.mjs";

const selections = new Map(), drafts = new Map();
const key = draftKeyOf;
const clock = ctx => ctx.services.now?.() ?? Date.now();
const command = (ctx,id,args=[]) => ctx.commands.format({routeId:id,args});
const fail = message => { throw Object.assign(new Error(message),{publicMessage:message}); };
export const clearCatalog = () => { selections.clear(); drafts.clear(); };
export function clearCatalogDraft(event) {drafts.delete(key(event));selections.delete(key(event));}
function remember(ctx,type,items) { selections.set(key(ctx.event),{type,items:items.map(x=>x.id),expires:clock(ctx)+600000}); }
export function isCatalogInput(event) { return !event.isGroup && (drafts.has(key(event)) || ((/^\d+$/.test(event.cleanText || "") || event.cleanText === "取消") && selections.has(key(event)))); }
export async function catalogInput(ctx) {
  if (!hasChatAdmin(ctx.event,{vault:ctx.vault,dispatcher:ctx.dispatcher})) { drafts.delete(key(ctx.event)); selections.delete(key(ctx.event)); return {status:"DENIED"}; }
  const k=key(ctx.event), raw=String(ctx.event.cleanText || "").trim(), draft=drafts.get(k);
  if(isSensitiveText(raw))return ctx.event.reply("输入包含凭据或可执行消息段，已拒绝保存；请填写配置引用。");
  if (draft) {
    if (clock(ctx)>draft.expires || raw==="取消") { drafts.delete(k); await ctx.event.reply("配置向导已结束。"); return; }
    draft.expires=clock(ctx)+600000;
    if (draft.kind==="connection") return connectionStep(ctx,draft,raw);
    if (draft.kind==="model") return modelStep(ctx,draft,raw);
    if (draft.kind==="character") return characterStep(ctx,draft,raw);
  }
  if(raw === "取消") {selections.delete(k);await ctx.event.reply("已关闭本次列表选择。");return;}
  const list=selections.get(k);
  if(!list || clock(ctx)>list.expires) { selections.delete(k); await ctx.event.reply("列表已过期，请重新查看列表。"); return; }
  const id=list.items[Number(raw)-1];
  if(!id) { await ctx.event.reply("编号不在本次列表中，请重新选择。"); return; }
  selections.delete(k);
  if(list.type==="defaultModel") return defaultModel({...ctx,args:[id]});
  if(list.type==="model") return useModel({...ctx,args:[id]});
  if(list.type.startsWith("discover:")) return beginModel(ctx,list.type.slice(9),id);
  if(list.type==="character") return ctx.dispatcher.plugins.get("chat-ai").routes.find(r=>r.id==="characterUse").action({...ctx,args:[id]});
  return connectionInfo({...ctx,args:[id]});
}

export async function settings(ctx) {
  return configurationSettings(ctx);
}
export async function connectionList(ctx) {
  const rows=ctx.services.store.listConnections(); remember(ctx,"connection",rows);
  await ctx.event.reply(["【服务连接】",...rows.map((r,i)=>`${i+1}. ${r.label} | ${r.endpoint} | 密钥${process.env[r.apiKeyEnv]?.trim()?'已配置':'缺失'}`),rows.length?"私聊回复编号查看详情。":`暂无连接，使用 ${command(ctx,'connectionAdd')} 添加。`].join("\n"));
}
function resolve(items,value) {
  return items.find(x=>x.id===value) || (items.filter(x=>x.label===value || x.name===value).length===1?items.find(x=>x.label===value || x.name===value):null);
}
export async function connectionInfo(ctx) {
  const r=resolve(ctx.services.store.listConnections(),ctx.args[0]); if(!r) return connectionList(ctx);
  const ep=validateChatEndpoint(r.endpoint);
  await ctx.event.reply([`【服务：${r.label}】`,`标识：${r.id}`,`地址：${r.endpoint}`,`实际聊天路径：${ep.url || ep.reason}`,`密钥：${process.env[r.apiKeyEnv]?.trim()?'已配置':'未配置'}`,`模型：${ctx.services.store.listModels().filter(m=>m.connectionId===r.id).map(m=>m.label || m.id).join('、') || '尚未添加'}`,`发现模型：${command(ctx,'connectionDiscover',[r.id])}`,`手动添加：${command(ctx,'modelAdd',[r.id])}`].join("\n"));
}
export async function connectionAdd(ctx) { return beginConnection(ctx,null); }
export async function connectionEdit(ctx) {
  const existing=resolve(ctx.services.store.listConnections(),ctx.args[0]); if(!existing) return connectionList(ctx);
  return beginConnection(ctx,existing);
}
async function beginConnection(ctx,existing) {
  if(ctx.event.isGroup) return ctx.event.reply("服务配置请在私聊进行。");
  clearDraft(key(ctx.event));
  drafts.set(key(ctx.event),{kind:"connection",step:"label",data:existing?{...existing}:{},expires:clock(ctx)+600000});
  await ctx.event.reply("【服务配置 1/3】给服务起一个易读名称，例如 主服务。已有值可回复「跳过」，随时回复「取消」。");
}
async function connectionStep(ctx,d,raw) {
  if(d.step==="label") { if(raw!=="跳过" || !d.data.label) d.data.label=clipText(raw,60); if(!d.data.label)return; d.step="endpoint"; return ctx.event.reply("【服务配置 2/3】输入 OpenAI 兼容 base URL，例如 https://api.example.com/v1。"); }
  if(d.step==="endpoint") { if(raw!=="跳过" || !d.data.endpoint) {const v=validateChatEndpoint(raw);if(!v.ok)return ctx.event.reply(v.reason);d.data.endpoint=raw;} d.step="key";
    const names=Object.keys(process.env).filter(n=>/^CHATAI_KEY_[A-Z0-9_]{1,56}$/.test(n)).map(n=>n+"（"+(process.env[n]?.trim()?"已配置":"空")+"）");
    return ctx.event.reply("【服务配置 3/3】输入密钥环境变量名，示例 CHATAI_KEY_MAIN。\n可见引用："+(names.join("、") || "无；需要维护者在运行环境提供密钥")); }
  if(d.step==="key") { if(raw!=="跳过" || !d.data.apiKeyEnv) {const v=validateApiKeyEnvName(raw);if(!v.ok)return ctx.event.reply(v.reason);d.data.apiKeyEnv=v.name;} d.step="confirm";return ctx.event.reply(`服务：${d.data.label}\n地址：${d.data.endpoint}\n密钥：${process.env[d.data.apiKeyEnv]?.trim()?'已配置':'缺失，保存后仍不能调用'}\n回复「确认」保存或「取消」。`); }
  if(raw!=="确认")return ctx.event.reply("请回复「确认」或「取消」。");
  d.data.id ||= "service-"+crypto.randomUUID().replaceAll("-","").slice(0,12);
  ctx.services.store.saveConnection(d.data);drafts.delete(key(ctx.event));
  await ctx.event.reply(`服务已保存。添加模型：${command(ctx,'modelAdd',[d.data.id])}；发现模型：${command(ctx,'connectionDiscover',[d.data.id])}。`);
}
export async function connectionDelete(ctx) {
  const row=resolve(ctx.services.store.listConnections(),ctx.args[0]);if(!row)return ctx.event.reply("未找到唯一的服务连接。");
  ctx.services.store.deleteConnection(row.id);await ctx.event.reply("服务连接已删除。");
}
export async function connectionDiscover(ctx) {
  if(ctx.event.isGroup)return ctx.event.reply("模型发现请在私聊进行。");
  const rows=ctx.services.store.listConnections(), row=resolve(rows,ctx.args[0]) || (rows.length===1?rows[0]:null);
  if(!row)return connectionList(ctx);
  const ep=validateChatEndpoint(row.endpoint);if(!ep.ok)fail(ep.reason);
  const secret=process.env[row.apiKeyEnv];if(!secret?.trim())fail("服务密钥未配置，请维护者配置运行环境。");
  try {
    const response=await ctx.services.fetchImpl(ep.url.replace(/\/chat\/completions$/,"/models"),{headers:{Authorization:"Bearer "+secret.trim()},redirect:"error",signal:AbortSignal.timeout(5000)});
    if(!response.ok) {await response.body?.cancel();fail("模型列表查询失败，HTTP "+response.status);}
    const body=await response.json(); if(!Array.isArray(body.data))fail("接口没有返回标准模型列表，可手动添加模型。");
    const ids=[...new Set(body.data.map(m=>m?.id).filter(id=>typeof id==="string" && id.length<=128 && !/[\r\n\x00-\x1f]/.test(id)))].slice(0,100);
    const pages=Math.max(1,Math.ceil(ids.length/20)), page=Math.min(pages,Math.max(1,Math.trunc(Number(ctx.args[1])) || 1)), visible=ids.slice((page-1)*20,page*20);
    remember(ctx,"discover:"+row.id,visible.map(id=>({id})));
    await ctx.event.reply([`【${row.label} 的模型】第${page}/${pages}页`,...visible.map((id,i)=>`${i+1}. ${id}`),"回复编号添加该模型；列表可达不等于生成已验证。",page<pages?command(ctx,'connectionDiscover',[row.id,page+1]):""].join("\n"));
  } catch(error) {await ctx.event.reply(error.publicMessage || "模型列表查询失败，请检查网络或手动添加模型。");}
}
export async function modelAdd(ctx) {return beginModel(ctx,ctx.args[0]);}
async function beginModel(ctx,connectionId,upstream=null) {
  if(ctx.event.isGroup)return ctx.event.reply("模型添加请在私聊进行。");
  const connections=ctx.services.store.listConnections(), c=resolve(connections,connectionId) || (connections.length===1?connections[0]:null);if(!c)return connectionList(ctx);
  clearDraft(key(ctx.event));
  drafts.set(key(ctx.event),{kind:"model",step:upstream?"label":"upstream",data:{connectionId:c.id,model:upstream},expires:clock(ctx)+600000});
  await ctx.event.reply(upstream?"给这个模型起一个显示名称，例如 日常聊天：":"输入服务支持的模型 ID，或取消后使用「发现模型」选择：");
}
async function modelStep(ctx,d,raw) {
  if(d.step==="upstream") {if(!raw || raw.length>128 || /[\r\n\x00-\x1f]/.test(raw))return ctx.event.reply("模型 ID 应为1至128个字符。");d.data.model=raw;d.step="label";return ctx.event.reply("给模型起一个显示名称，例如 日常聊天：");}
  if(d.step==="label") {d.data.label=clipText(raw,60);d.step="confirm";return ctx.event.reply(`名称：${d.data.label}\n模型：${d.data.model}\n回复「确认」保存；「确认并使用」保存并用于当前会话。`);}
  if(!["确认","确认并使用"].includes(raw))return ctx.event.reply("请回复「确认」「确认并使用」或「取消」。");
  const {store}=ctx.services;
  if(!store.getConnection(d.data.connectionId)) {drafts.delete(key(ctx.event));return ctx.event.reply("服务连接已删除，请重新添加。");}
  d.data.id="model-"+crypto.randomUUID().replaceAll("-","").slice(0,12);store.saveModel(d.data);drafts.delete(key(ctx.event));
  if(raw==="确认并使用")return useModel({...ctx,args:[d.data.id]});
  await ctx.event.reply(`模型「${d.data.label}」已保存。使用：${command(ctx,'modelUse',[d.data.id])}`);
}
export async function modelList(ctx) {
  const {store,health,config}=ctx.services, all=store.listModels(), page=Math.max(1,Math.trunc(Number(ctx.args[0])) || 1), rows=all.slice((page-1)*15,page*15), data=sessionDataOf(ctx.event), session=store.getSession(data.sessionId);
  const def=(store.getSetting("defaultModel") ?? (health.defaultProfileId || config.model.defaultProfileId));
  remember(ctx,ctx.defaultSelection?"defaultModel":"model",rows);
  await ctx.event.reply([`【模型列表】第${page}/${Math.max(1,Math.ceil(all.length/15))}页`,...rows.map((m,i)=>`${i+1}. ${m.label || m.id}${m.id===(session?.modelProfileId || def)?' ✓当前':''}${m.id===def?' ★默认':''}\n   ${m.model} | ${store.getConnection(m.connectionId)?.label || m.connectionId}\n   标识：${m.id} | 密钥${process.env[m.apiKeyEnv]?.trim()?'已配置':'缺失'} | ${store.getSetting("generation:"+m.id)?.code || health.profiles.find(h=>h.id===m.id)?.status || '未检测'}`),"密钥：CHATAI_KEY_***（只显示是否配置，不显示密钥值）",rows.length?`私聊回复编号${ctx.defaultSelection?'设置全局默认':'切换本会话'}；也可 ${command(ctx,'modelUse',['<名称或ID>'])}`:`目前没有模型档案。添加服务：${command(ctx,'connectionAdd')}`,page*15<all.length?command(ctx,'modelList',[page+1]):""].join("\n"));
}
export async function useModel(ctx) {
  const {store}=ctx.services, data=sessionDataOf(ctx.event), value=ctx.args.join(" "); store.ensureSession(data);
  if(["默认","跟随默认"].includes(value)) {store.setModelProfile(data.sessionId,null);ctx.services.engine.cancel(data.sessionId);return ctx.event.reply("本会话已跟随全局默认模型，旧请求已取消。");}
  const row=resolve(store.listModels(),value);if(!row)return ctx.event.reply("未找到唯一的模型名称或 ID，请查看模型列表。");
  if(!process.env[row.apiKeyEnv]?.trim())return ctx.event.reply("该模型的密钥尚未配置，未切换。");
  store.setModelProfile(data.sessionId,row.id);ctx.services.engine.cancel(data.sessionId);
  await ctx.event.reply(`本会话已使用「${row.label || row.id}」（${row.model}），立即生效。生成能力需通过对话验证。`);
}
export async function defaultModel(ctx) {
  const {store}=ctx.services, row=resolve(store.listModels(),ctx.args.join(" "));
  if(!row) {if(ctx.args.length)return ctx.event.reply("未找到唯一的模型名称或ID，默认模型未修改。");return modelList({...ctx,defaultSelection:true});}
  if(!process.env[row.apiKeyEnv]?.trim())return ctx.event.reply("模型密钥未配置，未修改默认模型。");
  store.setSetting("defaultModel",row.id);store.db.prepare("UPDATE chat_sessions SET epoch=epoch+1 WHERE model_profile_id IS NULL").run();
  await ctx.event.reply(`默认模型已设为「${row.label || row.id}」。跟随默认的会话立即生效，单独指定模型的会话保持原选择。`);
}
export async function modelInfo(ctx) {
  const {store,health,config}=ctx.services, session=store.getSession(sessionDataOf(ctx.event).sessionId);
  const row=ctx.args.length?resolve(store.listModels(),ctx.args.join(" ")):store.getModel(session?.modelProfileId || (store.getSetting("defaultModel") ?? (health.defaultProfileId || config.model.defaultProfileId)) || "");
  if(!row)return ctx.args.length?ctx.event.reply("未找到唯一的模型名称或ID，请重新查看模型列表。"):settings(ctx);
  const c=store.getConnection(row.connectionId), ep=validateChatEndpoint(row.endpoint);
  await ctx.event.reply([`【模型：${row.label || row.id}】`,`标识：${row.id}`,`服务：${c?.label || row.connectionId}`,`上游模型：${row.model}`,`地址：${row.endpoint}`,`实际路径：${ep.url || ep.reason}`,`密钥：${process.env[row.apiKeyEnv]?.trim()?'已配置':'缺失'}`,`温度：${row.temperature ?? config.model.temperature}`,`输出上限：${row.maxOutputTokens ?? config.model.maxOutputTokens}`,`上下文预算：${row.maxContextChars ?? config.model.maxContextChars}字符（人物与规则最多占60%）`,`超时：${row.timeoutMs ?? config.model.timeoutMs} ms`,`最近生成：${ctx.services.store.getSetting("generation:"+row.id)?.code || "未验证"}；模型列表检测只验证连通性`].join("\n"));
}
export async function modelRename(ctx) {
  const [id,...words]=ctx.args, row=resolve(ctx.services.store.listModels(),id), label=clipText(words.join(" "),60);
  if(!row || !label)return ctx.event.reply("请提供模型 ID 和显示名称。");
  ctx.services.store.saveModel({...row,label});await ctx.event.reply("模型显示名称已更新。");
}
export async function retry(ctx) {
  const {store,engine}=ctx.services,data=sessionDataOf(ctx.event),session=store.ensureSession(data);
  const row=store.recentMessages(data.sessionId,store.runtimeConfig(data.sessionId,ctx.services.config).retention.maxMessages).filter(m=>m.role==="user").at(-1);
  if(!row)return ctx.event.reply("当前人物分支还没有可以重试的问题。");
  if(!engine.enqueue({sessionId:data.sessionId,epoch:session.epoch,text:row.text,reply:ctx.event.reply,isGroup:ctx.event.isGroup,trigger:"explicit"}))await ctx.event.reply("队列已满。");
}
export async function cancel(ctx) {
  const data=sessionDataOf(ctx.event);ctx.services.store.ensureSession(data);ctx.services.store.bumpEpoch(data.sessionId);ctx.services.engine.cancel(data.sessionId);await ctx.event.reply("本会话在途回复和待回复队列已取消。");
}
export async function characterEdit(ctx) {
  if(ctx.event.isGroup)return ctx.event.reply("人物编辑请在私聊进行。");
  const row=ctx.services.store.getCharacter(ctx.args[0]);if(!row)return ctx.event.reply("请提供人物 ID。");
  clearDraft(key(ctx.event));
  drafts.set(key(ctx.event),{kind:"character",step:"field",data:row,expires:clock(ctx)+600000});
  await ctx.event.reply("要编辑哪个字段？可选 name、description、personality、scenario、first_mes、mes_example。回复「取消」退出。");
}
async function characterStep(ctx,d,raw) {
  if(d.step==="field") {if(!["name","description","personality","scenario","first_mes","mes_example"].includes(raw))return ctx.event.reply("请选择列出的字段。");d.field=raw;d.step="value";return ctx.event.reply("请输入新的字段内容，最多4000字符：");}
  if(d.step==="value") {if(isSensitiveText(raw))return ctx.event.reply("内容包含凭据模式，已拒绝。");d.data.card[d.field]=clipText(raw,4000);d.step="confirm";return ctx.event.reply("回复「确认」保存人物修改，或「取消」。");}
  if(raw!=="确认")return ctx.event.reply("请回复「确认」或「取消」。");
  if(!ctx.services.store.getCharacter(d.data.id)) {drafts.delete(key(ctx.event));return ctx.event.reply("人物已删除，请重新操作。");}
  const validated=parseCharacterCard(d.data.card,{owner:ctx.event.unifiedUserId});
  ctx.services.store.saveCharacter({...d.data,card:validated.card,name:validated.card.name || d.data.name});
  ctx.services.store.db.prepare("UPDATE chat_sessions SET epoch=epoch+1 WHERE character_id=?").run(d.data.id);
  drafts.delete(key(ctx.event));await ctx.event.reply("人物已更新，旧回复任务已失效。");
}
export {remember};

export async function modelOptions(ctx) {
  const [id,field,value]=ctx.args,row=resolve(ctx.services.store.listModels(),id);
  const rules={"温度":["temperature",0,2],"输出":["maxOutputTokens",1,4096],"超时":["timeoutMs",1000,120000],"上下文":["maxContextChars",2000,80000]};
  const rule=Object.hasOwn(rules,field)?rules[field]:null,number=Number(value);
  if(!row || !rule || !Number.isFinite(number) || number<rule[1] || number>rule[2] || (field!=="温度" && !Number.isInteger(number)))return ctx.event.reply("请输入模型 ID、参数（温度0–2 / 输出1–4096 / 超时1000–120000毫秒 / 上下文2000–80000字符）和值。");
  ctx.services.store.saveModel({...row,[rule[0]]:number});await ctx.event.reply("模型参数已更新，相关旧请求已失效。");
}
