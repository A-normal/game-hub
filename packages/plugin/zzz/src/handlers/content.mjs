import {requireRole,problem,plain,page,dataLines,shown} from "../text.mjs";
import {storeFor} from "../storage.mjs";
import {normalizeOfficialAvatar,findAvatar} from "../panel.mjs";
function sourceUrl(input) { try { const url=new URL(input); if (url.protocol!=="https:" || url.username || url.password) return null; return url.href; } catch {return null;} }
export async function handleContent(ctx) {
  if (ctx.routeId==="codes" && !ctx.config.content?.codes) {
    const result=await ctx.client.liveCodes();
    const now=ctx.services.now?.() ?? Date.now();
    const active=result.codes.filter(row=>!row.expiresAt || (typeof row.expiresAt==="number"?row.expiresAt*1000:Date.parse(row.expiresAt))>now);
    await ctx.event.reply(["【绝区零官方兑换码】",plain(result.title,200),...active.map(row=>plain(row.title,300)+"："+plain(row.code,100)),...(active.length?[]:["官方暂未返回可用兑换码。"]),"来源："+result.source,"查询时间："+new Date(now).toISOString(),"有效期以官方公告为准。"].join("\n"));return;
  }
  if (ctx.routeId==="skills") {
    const role=await requireRole(ctx); if (!role) return;
    const list=await ctx.client.record("avatars",role.uid,role.region);
    const avatar=findAvatar((list.avatar_list || []).map(normalizeOfficialAvatar),ctx.args.join(" "),storeFor(ctx).option(ctx.event.unifiedUserId,"aliases",{}));
    if (!avatar) throw problem("请指定当前账号的完整角色名或角色 ID。");
    const data=await ctx.client.record("avatar",role.uid,role.region,{id_list:[avatar.id],need_wiki:true});
    const item=data.avatar_list?.find(row=>String(row.id)===avatar.id);
    if (!item) throw problem("官方未返回该角色资料。");
    const output=dataLines({skills:item.skills,talents:item.talents,wiki:item.wiki || data.wiki});
    await ctx.event.reply(["【角色文字资料】"+avatar.name,"来源：米游社角色接口",...(output.length?output:["官方未返回可显示的文字资料。"] )].join("\n")); return;
  }
  const now=ctx.services.now?.() ?? Date.now();
  const records=ctx.routeId==="codes" ? ctx.config.content?.codes || [] : ctx.config.content?.guides || [];
  const query=ctx.args.filter(v=>!/^\d+$/.test(v)).join(" ");
  const entries=records.filter(row=>row.source && sourceUrl(row.url) && (!row.expiresAt || Date.parse(row.expiresAt)>now) && (!query || JSON.stringify(row).includes(query)));
  const p=page(entries,ctx.args.find(v=>/^\d+$/.test(v)),6);
  const lines=[ctx.routeId==="codes"?"【绝区零兑换码】":"【绝区零攻略】"];
  for (const row of p.items) {
    lines.push(plain(row.title || row.code || "",200));
    if (row.code) lines.push("兑换码："+shown(row.code));
    if (row.text) lines.push(plain(row.text,1800));
    else if (ctx.routeId!=="codes") lines.push("此来源只提供原文或图片，请打开链接查看。");
    lines.push("来源："+shown(row.source)+" "+sourceUrl(row.url),"有效期："+shown(row.expiresAt));
  }
  if (!entries.length) lines.push("官方百科：https://www.miyoushe.com/zzz/wiki",...(query?["攻略搜索：https://wiki.biligame.com/zzz/index.php?search="+encodeURIComponent(query)]:[]),"本轮不下载或识别图片攻略；可通过内容配置添加有来源的纯文字条目。");
  lines.push("第 "+p.number+" / "+p.total+" 页"); await ctx.event.reply(lines.join("\n"));
}
