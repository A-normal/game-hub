import crypto from "node:crypto";
import {beginInput} from "./input.mjs";
import {clipText} from "./session.mjs";
const LIMIT=4*1024*1024;
const error=message=>Object.assign(new Error(message),{publicMessage:message});
export function publicImage(value) {
  try {const u=new URL(value),h=u.hostname.toLowerCase().replace(/[\[\]]/g,"");return u.protocol==="https:" && !u.username && !u.password && !u.hash && !h.includes(":") && !h.endsWith(".local") && !h.endsWith(".localhost") && h!=="localhost" && !/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);}catch{return false;}
}
export function validateImage(bytes) {
  if(!bytes.length || bytes.length>LIMIT)throw error("图片为空或超过4 MiB。");
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return "image/png";
  if(bytes[0]===255 && bytes[1]===216 && bytes[2]===255)return "image/jpeg";
  if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()))return "image/gif";
  if(bytes.subarray(0,4).toString()==="RIFF" && bytes.subarray(8,12).toString()==="WEBP")return "image/webp";
  throw error("图片格式无法识别，支持 PNG、JPEG、GIF、WebP。");
}
export function saveAsset(store,{id,label,file,tags=[],characterId="",replace=false}) {
  if(!/^[a-z0-9_-]{1,40}$/.test(id || "") || !label || label.length>60)throw error("素材需要1–40位短ID和最多60字名称。");
  const existing=store.db.prepare("SELECT id FROM chat_stickers WHERE id=?").get(id);
  if(existing && !replace)throw error("素材 ID 已存在；使用表情替换指令明确替换。");
  if(characterId && !store.getCharacter(characterId))throw error("素材关联的人物不存在。");
  if(!Array.isArray(tags) || tags.length>20 || tags.some(t=>typeof t!=="string" || t.length>30))throw error("最多20个标签，每个最多30字。");
  if(typeof file!=="string")throw error("素材缺少图片数据。");
  let hash,status;
  if(file.startsWith("base64://")) {
    const source=file.slice(9);
    if(source.length>Math.ceil(LIMIT/3)*4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source))throw error("图片编码无效或过大。");
    const bytes=Buffer.from(source,"base64");if(bytes.toString("base64")!==source)throw error("图片编码无效。");
    validateImage(bytes);hash=crypto.createHash("sha256").update(bytes).digest("hex");status="stored";
    const duplicate=store.db.prepare("SELECT id FROM chat_asset_meta WHERE hash=? AND id<>?").get(hash,id);
    if(duplicate)throw error("相同图片已登记为 "+duplicate.id+"。");
  } else {if(!publicImage(file))throw error("只接受上传图片或公开 HTTPS 图片地址。");hash=null;status="remote-unchecked";}
  store.db.prepare("INSERT INTO chat_stickers(id,label,file,tags) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,file=excluded.file,tags=excluded.tags").run(id,label,file,JSON.stringify(tags));
  store.db.prepare("INSERT INTO chat_asset_meta(id,hash,status,character_id) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,status=excluded.status,character_id=excluded.character_id").run(id,hash,status,characterId);
}
export function availableAssets(store,characterId="") {
  return store.db.prepare("SELECT s.id,s.label,s.tags FROM chat_stickers s LEFT JOIN chat_asset_meta m ON m.id=s.id WHERE m.character_id IS NULL OR m.character_id='' OR m.character_id=? ORDER BY s.id LIMIT 50").all(characterId).map(row=>({...row,tags:JSON.parse(row.tags)}));
}
function beginUpload(ctx,id,label,replace=false) {
  if(ctx.event.isGroup)return ctx.event.reply("素材上传请在私聊进行。");
  if(!/^[a-z0-9_-]{1,40}$/.test(id || ""))return ctx.event.reply("请提供1–40位小写字母、数字、下划线或短横线组成的 ID。");
  beginInput(ctx,{kind:"sticker",maxBytes:LIMIT,accept:async({bytes,ctx,valid})=>{
    validateImage(bytes);if(!valid())return;
    const prior=ctx.services.store.db.prepare("SELECT tags FROM chat_stickers WHERE id=?").get(id),meta=ctx.services.store.db.prepare("SELECT character_id FROM chat_asset_meta WHERE id=?").get(id);
    ctx.vault._transaction(()=>saveAsset(ctx.services.store,{id,label,file:"base64://"+bytes.toString("base64"),replace,tags:prior?JSON.parse(prior.tags):[],characterId:meta?.character_id || ""}));
    await ctx.event.reply(`已保存表情 ${id}；图片由本地素材库保管，不依赖 QQ 临时链接。`);
  }});
  return ctx.event.reply("请在10分钟内单独发送一张 PNG/JPEG/GIF/WebP 图片文件（最多4 MiB）。回复取消可退出。");
}
export async function stickerAdd(ctx) {
  if(ctx.event.isGroup)return ctx.event.reply("素材登记请在私聊进行。");
  const [id,second,...rest]=ctx.args;
  if(second && /^[a-z]+:\/\//i.test(second)) {ctx.vault._transaction(()=>saveAsset(ctx.services.store,{id,file:second,label:clipText(rest.join(" "),60)}));return ctx.event.reply("远程素材已登记（链接有效性未验证，可能过期）。建议改为上传图片。");}
  return beginUpload(ctx,id,clipText([second,...rest].filter(Boolean).join(" ") || id,60));
}
export async function stickerReplace(ctx) {
  const row=ctx.services.store.db.prepare("SELECT label FROM chat_stickers WHERE id=?").get(ctx.args[0] || "");
  if(!row)return ctx.event.reply("素材不存在。");return beginUpload(ctx,ctx.args[0],row.label,true);
}
export async function stickerTags(ctx) {
  const [id,tags="",character="*"]=ctx.args,store=ctx.services.store,row=store.db.prepare("SELECT * FROM chat_stickers WHERE id=?").get(id || "");
  if(!row)return ctx.event.reply("素材不存在。");
  const old=store.db.prepare("SELECT hash,status FROM chat_asset_meta WHERE id=?").get(id);
  if(character!=="*" && !store.getCharacter(character))return ctx.event.reply("人物不存在；* 表示通用素材。");
  const list=tags==="-"?[]:tags.split(/[,，]/).filter(Boolean);if(list.length>20 || list.some(t=>t.length>30))return ctx.event.reply("最多20个标签，每个最多30字。");
  ctx.vault._transaction(()=>{store.db.prepare("UPDATE chat_stickers SET tags=? WHERE id=?").run(JSON.stringify(list),id);store.db.prepare("INSERT INTO chat_asset_meta VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET character_id=excluded.character_id").run(id,old?.hash || null,old?.status || "remote-unchecked",character==="*"?"":character);});
  await ctx.event.reply("素材标签与人物范围已更新。");
}
export async function stickerPreview(ctx) {
  const row=ctx.services.store.db.prepare("SELECT label,file FROM chat_stickers WHERE id=?").get(ctx.args[0] || "");
  if(!row)return ctx.event.reply("素材不存在。");await ctx.event.reply(row.label);await ctx.event.reply({segments:[{type:"image",file:row.file}]});
}
export async function stickerList(ctx) {
  const rows=ctx.services.store.db.prepare("SELECT s.id,s.label,s.tags,COALESCE(m.status,'remote-unchecked') AS status,COALESCE(m.character_id,'') AS character FROM chat_stickers s LEFT JOIN chat_asset_meta m ON m.id=s.id ORDER BY s.id").all(),pages=Math.max(1,Math.ceil(rows.length/15)),page=Number(ctx.args[0] || 1);
  if(!Number.isInteger(page) || page<1 || page>pages)return ctx.event.reply(`页码范围1–${pages}。`);
  await ctx.event.reply([`【表情素材】${page}/${pages}页，共${rows.length}个`,...rows.slice((page-1)*15,page*15).map(r=>`${r.id} | ${r.label} | ${r.tags} | ${r.character || '通用'} | ${r.status==='stored'?'已存储':'远程链接待验证'}`)].join("\n"));
}
export async function stickerDelete(ctx) {const store=ctx.services.store,id=ctx.args[0] || "";let n;ctx.vault._transaction(()=>{n=store.db.prepare("DELETE FROM chat_stickers WHERE id=?").run(id).changes;store.db.prepare("DELETE FROM chat_asset_meta WHERE id=?").run(id);});await ctx.event.reply(n?"素材已删除。":"未找到素材。");}
export async function stickerImport(ctx) {
  if(ctx.event.isGroup)return ctx.event.reply("批量导入请在私聊进行。");
  beginInput(ctx,{kind:"assets",maxBytes:LIMIT,extensions:/\.json$/i,accept:async({bytes,ctx,valid})=>{
    const parsed=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    if(!Array.isArray(parsed.assets) || !parsed.assets.length || parsed.assets.length>100)throw error("素材包需有1–100条 assets 记录。");
    if(!valid())return;
    ctx.vault._transaction(()=>{for(const row of parsed.assets)saveAsset(ctx.services.store,{...row,replace:false});});
    await ctx.event.reply(`已原子导入${parsed.assets.length}个素材。重复ID或无效素材会整包拒绝。`);
  }});
  return ctx.event.reply('请单独发送JSON素材包：{"assets":[{"id":"happy","label":"开心","file":"https://cdn.example.com/happy.png","tags":["开心"],"characterId":""}]}。也可将 file 设为 base64://图片数据。');
}
