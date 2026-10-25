import { handleLoginQr } from "./login-qr.mjs";
import { command, problem } from "../text.mjs";
import crypto from "node:crypto";
export async function handleBind(ctx) {
  const cookie = ctx.args.join(" ").trim();
  if (!cookie) return handleLoginQr(ctx);
  if (ctx.event.isGroup) { await ctx.event.reply("请在私聊中提交凭据；已发到群中的凭据建议在官方客户端撤销。"); return {status:"DENIED"}; }
  const pairs = Object.fromEntries(cookie.split(";").map(v => { const p = v.indexOf("="); return p > 0 ? [v.slice(0,p).trim(),v.slice(p+1).trim()] : []; }).filter(v=>v.length===2));
  const accounts = [...new Set(["ltuid","ltuid_v2","account_id","account_id_v2","stuid"].map(k=>pairs[k]).filter(Boolean))];
  if (accounts.length !== 1 || !/^\d+$/.test(accounts[0]) || !["ltoken","ltoken_v2","cookie_token","cookie_token_v2","stoken","stoken_v2"].some(k=>pairs[k])) throw problem("Cookie 身份或令牌不完整。建议使用「"+command(ctx,"loginQr")+"」。");
  const client = ctx.provider.createClient({ck:cookie});
  const global = ctx.matchedToken === "绑定国际服";
  const rawRoles = await client.getUserGameRoles(global ? "nap_global" : "nap_cn");
  const roles = rawRoles.map(r => {
    if (!/^\d+$/.test(String(r.game_uid)) || !r.region) throw problem("官方角色数据格式异常，未写入绑定。");
    return {uid:String(r.game_uid),region:r.region,nickname:r.nickname || String(r.game_uid),level:Number(r.level || 0)};
  });
  ctx.vault.saveAccountBinding({unifiedUserId:ctx.event.unifiedUserId,platform:ctx.event.platform,originalId:ctx.event.sender?.id,providerId:"mihoyo",accountKey:(global?"global:":"")+accounts[0],gameId:"zzz",cookies:{ck:cookie},device:{device_id:crypto.randomUUID()},roles});
  const active=ctx.vault.getActiveRole(ctx.event.unifiedUserId,"zzz");
  await ctx.event.reply("【绝区零】通行证绑定成功！\n检测到 "+roles.length+" 个角色。\n"+roles.map(r=>"["+r.uid+"] "+r.nickname+" (Lv."+r.level+")"+(active?.uid===r.uid?" ★[当前主角色]":"")).join("\n")+"\n"+command(ctx,"listRoles")+"\n"+command(ctx,"note"));
}
