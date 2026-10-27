import {hasChatAdmin} from "./admin.mjs";
import {isSensitiveText} from "./session.mjs";
import {clearDraft} from "./wizard.mjs";
import {clearCatalogDraft} from "./catalog.mjs";
const buckets=new WeakMap();
const key=e=>JSON.stringify([e.platform,e.botId || "",e.isGroup?e.groupId:"private",e.unifiedUserId]);
const bucket=services=>{if(!buckets.has(services))buckets.set(services,new Map());return buckets.get(services);};
export const clearInputs=services=>buckets.delete(services);
export const cancelInput=(services,event)=>services && typeof services==="object" ? bucket(services).delete(key(event)) : false;
export function beginInput(ctx,{kind,maxBytes,extensions,accept}) {
  clearDraft([ctx.event.platform,ctx.event.botId,ctx.event.unifiedUserId].join(":"));clearCatalogDraft(ctx.event);
  bucket(ctx.services).set(key(ctx.event),{kind,maxBytes,extensions,accept,expires:ctx.services.now()+600000,busy:false});
}
export function isPendingInput(event,services) {return !event.isGroup && bucket(services).has(key(event));}
export async function consumeInput(ctx) {
  const {services,event}=ctx,map=bucket(services),id=key(event),draft=map.get(id);
  // An active upload must never swallow recall or other platform notices.
  if(event.eventType && event.eventType!=="message" && !event.attachments?.length)return false;
  if(!draft || event.isGroup)return false;
  const valid=()=>map.get(id)===draft && services.now()<draft.expires && hasChatAdmin(event,{vault:ctx.vault,dispatcher:ctx.dispatcher}) && ctx.dispatcher?.isPluginEnabled?.("chat-ai")!==false;
  if(!valid() || event.cleanText==="取消") {map.delete(id);await event.reply("文件导入已结束，请重新发起导入。");return true;}
  if(draft.busy)return true;
  draft.busy=true;
  try {
    const attachments=event.attachments || [];
    if(attachments.length>1)throw new Error("请一次只发送一个文件。");
    const attachment=attachments[0];
    let bytes,name="";
    if(attachment) {
      name=attachment.name;
      if(draft.extensions && !draft.extensions.test(name))throw new Error("文件格式不支持，请发送 TXT、Markdown 或 JSON。");
      if(attachment.size>draft.maxBytes)throw new Error("文件超过导入大小上限。");
      if(typeof attachment.readBytes!=="function")throw new Error("此渠道暂不支持读取附件。");
      bytes=await attachment.readBytes({maxBytes:draft.maxBytes});
    } else {
      if(!event.cleanText?.trim())return true;
      bytes=Buffer.from(event.cleanText,"utf8");
    }
    if(!Buffer.isBuffer(bytes))bytes=Buffer.from(bytes);
    if(bytes.length>draft.maxBytes)throw new Error("文件超过导入大小上限。");
    if(!valid())return true;
    await draft.accept({bytes,name,ctx,valid});
    if(map.get(id)===draft)map.delete(id);
  } catch(error) {
    if(valid())await event.reply("导入失败："+(error.publicMessage || error.message || "无法读取文件。")+" 可重发文件，或回复取消。");
  } finally {draft.busy=false;}
  return true;
}
export function decodeCardText(bytes) {
  let encoding="utf-8",offset=0;
  if(bytes[0]===255 && bytes[1]===254){encoding="utf-16le";offset=2;}
  else if(bytes[0]===254 && bytes[1]===255){encoding="utf-16be";offset=2;}
  let text;
  try{text=new TextDecoder(encoding,{fatal:true}).decode(bytes.subarray(offset));}catch {throw new Error("文本编码无法识别，请保存为 UTF-8 或带 BOM 的 UTF-16。");}
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))throw new Error("文件包含二进制内容，不能作为文本人物卡。");
  if(isSensitiveText(text))throw new Error("人物内容包含凭据或可执行消息段，已拒绝导入。");
  return text;
}
