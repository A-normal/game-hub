/**
 * @file packages/plugin/chat-ai/src/handlers/admin.mjs
 * @description 人物卡管理、策略设置与上下文管理指令。
 *              所有命令提示由 ctx.commands.format 动态生成。
 */

import {expandMacros} from "../prompt.mjs";
import {remember} from "../catalog.mjs";
import {MAX_CARD_BYTES,parseCharacterCard} from "../character.mjs";
import {beginInput,decodeCardText} from "../input.mjs";
import {clearDraft} from "../wizard.mjs";
import {clearCatalogDraft} from "../catalog.mjs";
import {changePreferences} from "../preferences.mjs";
import {clipText,isSensitiveText,resolvePolicy, servicesOf, sessionDataOf,draftKeyOf} from "../session.mjs";
import {
  modelAdd,
  modelCheck,
  modelList,
  modelRemove,
  modelSet
} from "../wizard.mjs";

export {modelAdd, modelSet, modelRemove, modelList, modelCheck};

const usage = (ctx, routeId, args) => "用法: " + ctx.commands.format({routeId, args});

export async function characterList(ctx) {
  const {store} = servicesOf(ctx);
  const characters = store.listCharacters();
  if (!characters.length) {
    await ctx.event.reply("目前没有人物卡。管理员可在私聊用 " + usage(ctx, "characterImport", ["<JSON>"]) + " 导入。");
    return;
  }
  if(!ctx.event.isGroup)remember(ctx,"character",characters);
  const lines = ["【人物卡】共 " + characters.length + " 个"];
  for (const [index,item] of characters.entries()) lines.push(`${ctx.event.isGroup?"列表序号":"选择编号"}：${index+1}\n名称：${item.name || "未命名"}\nID：${item.id}`);
  lines.push(ctx.event.isGroup?"群内请使用人物ID切换；编号选择仅支持私聊。":"私聊回复本次选择编号即可切换，10分钟内有效；选择编号不是人物ID。");
  lines.push("绑定: " + ctx.commands.format({routeId: "characterUse", args: ["<人物ID>"]}));
  await ctx.event.reply(lines.join("\n"));
}

export async function characterImport(ctx) {
  const {store} = servicesOf(ctx);
  const event = ctx.event;
  if (event.isGroup) {
    await event.reply("人物卡只能在私聊中导入。");
    return;
  }
  const raw = String(ctx.argumentText || "").trim();
  if (!raw) {
    clearDraft(draftKeyOf(event));clearCatalogDraft(event);
    beginInput(ctx,{kind:"character",maxBytes:MAX_CARD_BYTES,extensions:/\.(txt|md|markdown|json)$/i,accept:async({bytes,name,ctx,valid})=>{
      const text=decodeCardText(bytes);
      const parsed=parseCharacterCard(text,{owner:event.unifiedUserId,filename:name});
      if(!valid())return;
      await saveImportedCharacter(ctx,parsed);
    }});
    await event.reply("请在10分钟内单独发送 TXT、Markdown 或 JSON 人物卡（最多1 MiB），也可直接粘贴文本。无需将指令与文件放在同一条消息。回复取消可退出。");
    return;
  }
  if(isSensitiveText(raw))return event.reply("人物内容包含凭据或可执行消息段，已拒绝导入。");
  let parsed;
  try {
    parsed = parseCharacterCard(raw, {owner: event.unifiedUserId});
  } catch (error) {
    await event.reply("人物卡导入失败：" + (error?.publicMessage || "格式不正确。"));
    return;
  }
  return saveImportedCharacter(ctx,parsed);
}
async function saveImportedCharacter(ctx,parsed) {
  const {store}=ctx.services,event=ctx.event;
  if (store.getCharacter(parsed.id)) {
    await event.reply("同名人物已存在，未覆盖。请使用 " + ctx.commands.format({routeId:"characterOverwrite",args:[parsed.id,"<JSON>"]}) + " 明确覆盖，或在导入前修改名称。");
    return;
  }
  const name = parsed.card.name || parsed.id;
  store.saveCharacter({id: parsed.id, name, card: parsed.card, owner: event.unifiedUserId});
  const warnings = parsed.warnings.length ? "\n提示: " + parsed.warnings.join("；") : "";
  await event.reply(
    "已导入人物卡 " + parsed.id + "（" + name + "）。\n" +
    "使用 " + ctx.commands.format({routeId: "characterUse", args: [parsed.id]}) + " 在本会话启用。" + warnings
  );
}

export async function characterUse(ctx) {
  const {store} = servicesOf(ctx);
  const [id] = ctx.args || [];
  if (!id) { await ctx.event.reply(usage(ctx, "characterUse", ["<人物ID>"])); return; }
  const data = sessionDataOf(ctx.event);
  if (!data) { await ctx.event.reply("无法确定当前会话。"); return; }
  if(id==="跟随全局") {changePreferences(ctx,"local",[{key:"characterId",inherit:true}]);return ctx.event.reply("本会话人物已跟随全局，历史仍按会话和人物独立保留。");}
  const character = store.getCharacter(id);
  if (!character) { await ctx.event.reply("未找到人物卡 " + id + "。"); return; }
  store.ensureSession(data);
  store.setCharacter(data.sessionId, id);
  ctx.services.engine?.cancel(data.sessionId);
  if (!store.countMessages(data.sessionId) && character.card?.first_mes) {
    const greeting=clipText(expandMacros(character.card.first_mes,character.name,ctx.event.sender?.name || "朋友"),1000);
    const delivery=greeting && !isSensitiveText(greeting) ? await ctx.event.reply(greeting) : {success:false};
    if(delivery?.success!==false)store.insertMessage({sessionId:data.sessionId,role:"assistant",text:greeting});
  }
  await ctx.event.reply("本会话已切换人物: " + (character.name || id) + "（" + id + "）。");
}

export async function characterOff(ctx) {
  const {store} = servicesOf(ctx);
  const data = sessionDataOf(ctx.event);
  if (!data) { await ctx.event.reply("无法确定当前会话。"); return; }
  store.ensureSession(data);
  store.setCharacter(data.sessionId, null);
  ctx.services.engine?.cancel(data.sessionId);
  await ctx.event.reply("本会话已卸下人物卡，恢复通用助手人设。");
}

/**
 * 策略设置：支持 off|mention|all。私聊只接受 off/all。
 */
export async function policySet(ctx) {
  const {store} = servicesOf(ctx);
  const event = ctx.event;
  const data = sessionDataOf(event);
  if (!data) { await event.reply("无法确定当前会话。"); return; }
  const value = String((ctx.args || [])[0] || "").toLowerCase();
  if (!["off", "mention", "all","跟随全局"].includes(value)) {
    await event.reply(usage(ctx, "policySet", ["<off|mention|all|跟随全局>"]));
    return;
  }
  if (!event.isGroup && value === "mention") {
    await event.reply("私聊会话只接受 off 或 all；mention 仅用于群聊。");
    return;
  }
  store.ensureSession(data);
  changePreferences(ctx,"local",[{key:"policy",value,inherit:value==="跟随全局"}]);
  const lines = ["本会话策略已设为 " + value + "。"];
  if (value === "off") lines.push("off 会同时停止记录与回复：本会话之后的消息不再进入上下文，也不会得到自动回复。");
  lines.push("当前值: " + resolvePolicy(store.getSession(data.sessionId),ctx.services.config));
  await event.reply(lines.join("\n"));
}

export async function contextShow(ctx) {
  const {store} = servicesOf(ctx);
  const event = ctx.event;
  const data = sessionDataOf(event);
  if (!data) { await event.reply("无法确定当前会话。"); return; }
  const session = store.ensureSession(data);
  const config=store.runtimeConfig(data.sessionId,ctx.services.config);
  const model=store.getModel(session.modelProfileId || store.getSetting("defaultModel") || ctx.services.health?.defaultProfileId || config.model.defaultProfileId || ""), budget=store.getOption(data.sessionId,"maxContextChars",model?.maxContextChars ?? config.model.maxContextChars), card=store.getCharacter(session.characterId || "");
  await event.reply([
    "【上下文】",
    "会话: " + data.sessionId,
    "消息: " + store.countMessages(data.sessionId) + " / " + config.retention.maxMessages + " 条",
    "策略: " + resolvePolicy(session, config),
    "模型上下文预算: " + budget + "字符；人物与宿主规则最多占60%。",
    "人物保存大小: " + (card?Buffer.byteLength(JSON.stringify(card.card),"utf8"):0) + "字节；原卡完整保存，超过模型预算的设定仍会裁剪。",
    "说明: 为避免在群聊中展示他人内容，本指令只显示条数，不显示正文。"
  ].join("\n"));
}

export async function contextClear(ctx) {
  const {store} = servicesOf(ctx);
  const event = ctx.event;
  const data = sessionDataOf(event);
  if (!data) { await event.reply("无法确定当前会话。"); return; }
  store.ensureSession(data);
  const clear = () => {
    const removed = store.deleteMessages(data.sessionId);
    store.setOption(data.sessionId,"summary:"+store.branchOf(data.sessionId),"");
    store.setOption(data.sessionId,"summarySources:"+store.branchOf(data.sessionId),[]);
    store.bumpEpoch(data.sessionId);
    return removed;
  };
  ctx.services.engine?.cancel(data.sessionId);
  const removed = typeof ctx.vault?._transaction === "function" ? ctx.vault._transaction(clear) : clear();
  await event.reply("已清空本会话上下文（" + removed + " 条），并递增会话代号。");
}

export default {
  modelList,
  modelAdd,
  modelSet,
  modelRemove,
  modelCheck,
  characterList,
  characterImport,
  characterUse,
  characterOff,
  policySet,
  contextShow,
  contextClear
};

export async function characterPreview(ctx) {
  const {store}=servicesOf(ctx),row=store.getCharacter(ctx.args[0]);
  if(!row)return ctx.event.reply("未找到人物，请先查看人物列表。");
  const text=[row.card?.description || "暂无设定",`性格：${row.card?.personality || '未填写'}`,`开场白：${row.card?.first_mes || '未填写'}`].join("\n"),chars=Array.from(text),total=Math.max(1,Math.ceil(chars.length/1800)),page=Number(ctx.args[1] || 1);
  if(!Number.isInteger(page) || page<1 || page>total)return ctx.event.reply(`页码范围：1–${total}。`);
  await ctx.event.reply(`【${row.name}】第${page}/${total}页（保存${chars.length}字符）\n`+chars.slice((page-1)*1800,page*1800).join("")+`\n下一页：`+ctx.commands.format({routeId:"characterPreview",args:[row.id,Math.min(total,page+1)]}));
}
export async function characterExport(ctx) {
  if(ctx.event.isGroup)return ctx.event.reply("人物导出请在私聊进行。");
  const row=ctx.services.store.getCharacter(ctx.args[0]);if(!row)return ctx.event.reply("未找到人物。");
  const source=JSON.stringify({spec:"chara_card_v2",spec_version:"2.0",data:row.card},null,2);
  const result=await ctx.event.reply({text:`人物卡「${row.name}」已导出，说明与文件将分开发送。`,files:[{name:row.id+".json",data:Buffer.from(source,"utf8")}]});
  if(result?.success===false)await ctx.event.reply(result.partial?"说明已发送，文件未送达，请稍后重新导出。":"人物文件未送达，请检查渠道文件发送能力。");
}
export async function characterDelete(ctx) {
  const [id,confirm]=ctx.args,{store}=ctx.services,row=store.getCharacter(id || "");if(!row)return ctx.event.reply("未找到人物。");
  const affected=store.db.prepare("SELECT session_id FROM chat_sessions").all().filter(row=>store.getSession(row.session_id).characterId===id).length;
  if(confirm!=="确认")return ctx.event.reply(`删除「${row.name}」会解除${affected}个会话的绑定并删除此人物分支历史。确认：`+ctx.commands.format({routeId:"characterDelete",args:[id,"确认"]}));
  const remove=()=>{store.db.prepare("UPDATE chat_sessions SET character_id=NULL,epoch=epoch+1 WHERE character_id=?").run(id);store.db.prepare("DELETE FROM chat_messages WHERE branch_id=?").run(id);store.db.prepare("DELETE FROM chat_options WHERE key=?").run("summary:"+id);store.deleteCharacter(id);};
  ctx.vault._transaction(remove);await ctx.event.reply("人物与对应分支历史已删除，其它人物历史不变。");
}
export async function characterOverwrite(ctx) {
  if(ctx.event.isGroup)return ctx.event.reply("人物覆盖请在私聊进行。");
  const raw=String(ctx.argumentText || "").trim(),match=/^(\S+)\s+([\s\S]+)$/.exec(raw);
  if(!match) {
    const existing=ctx.services.store.getCharacter(raw);
    if(!existing)return ctx.event.reply("请提供要覆盖的人物 ID；之后单独发送人物卡文件。也可在 ID 后粘贴完整文本或JSON。");
    beginInput(ctx,{kind:"character",maxBytes:MAX_CARD_BYTES,extensions:/\.(txt|md|markdown|json)$/i,accept:async({bytes,name,ctx,valid})=>{
      const parsed=parseCharacterCard(decodeCardText(bytes),{owner:ctx.event.unifiedUserId,filename:name});
      if(!valid() || !ctx.services.store.getCharacter(existing.id))return;
      ctx.services.store.saveCharacter({id:existing.id,name:parsed.card.name || existing.name,card:parsed.card,owner:ctx.event.unifiedUserId});
      ctx.services.store.db.prepare("UPDATE chat_sessions SET epoch=epoch+1 WHERE character_id=?").run(existing.id);
      await ctx.event.reply("人物已覆盖，绑定保持不变，旧请求已失效。");
    }});
    return ctx.event.reply(`请在10分钟内单独发送要覆盖「${existing.name}」的 TXT、Markdown 或JSON 文件；回复取消退出。`);
  }
  const existing=ctx.services.store.getCharacter(match[1]);if(!existing)return ctx.event.reply("未找到要覆盖的人物。");
  if(isSensitiveText(match[2]))return ctx.event.reply("人物内容包含凭据或可执行消息段，已拒绝覆盖。");
  const parsed=parseCharacterCard(match[2],{owner:ctx.event.unifiedUserId});
  ctx.services.store.saveCharacter({id:existing.id,name:parsed.card.name || existing.name,card:parsed.card,owner:ctx.event.unifiedUserId});
  ctx.services.store.db.prepare("UPDATE chat_sessions SET epoch=epoch+1 WHERE character_id=?").run(existing.id);
  await ctx.event.reply("人物已明确覆盖；使用该人物的旧请求已失效。");
}
