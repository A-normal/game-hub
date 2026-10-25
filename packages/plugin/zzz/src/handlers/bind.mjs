import { handleLoginQr } from "./login-qr.mjs";
import { command, problem } from "../text.mjs";
import { title, divider } from "../layout.mjs";
import crypto from "node:crypto";
export async function handleBind(ctx) {
  const cookie = ctx.args.join(" ").trim();
  if (!cookie) return handleLoginQr(ctx);
  if (ctx.event.isGroup) { await ctx.event.reply("请在私聊中提交凭据；已发到群中的凭据建议在官方客户端撤销。"); return {status:"DENIED"}; }
  const pairs = Object.fromEntries(cookie.split(";").map(v => { const p = v.indexOf("="); return p > 0 ? [v.slice(0,p).trim(),v.slice(p+1).trim()] : []; }).filter(v=>v.length===2));
  const accounts = [...new Set(["ltuid","ltuid_v2","account_id","account_id_v2","stuid"].map(k=>pairs[k]).filter(Boolean))];
  if (accounts.length !== 1 || !/^\d+$/.test(accounts[0]) || !["ltoken","ltoken_v2","cookie_token","cookie_token_v2","stoken","stoken_v2"].some(k=>pairs[k])) throw problem("Cookie 身份或令牌不完整。建议使用「"+command(ctx,"loginQr")+"」。");
  const global = ctx.matchedToken === "绑定国际服";
  const accountKey=(global?"global:":"")+accounts[0];
  const existing=ctx.vault.getUserCredential(ctx.event.unifiedUserId,"mihoyo",accountKey);
  const device={...(existing?.device || {}),device_id:existing?.device?.device_id || crypto.randomUUID()};
  const client = ctx.provider.createClient({ck:cookie},device);
  const rawRoles = await client.getUserGameRoles(global ? "nap_global" : "nap_cn");
  const roles = rawRoles.map(r => {
    if (!/^\d+$/.test(String(r.game_uid)) || !r.region) throw problem("官方角色数据格式异常，未写入绑定。");
    return {uid:String(r.game_uid),region:r.region,nickname:r.nickname || String(r.game_uid),level:Number(r.level || 0)};
  });
  const previous=ctx.vault.getActiveRole(ctx.event.unifiedUserId,"zzz");
  const activeUid=roles.some(row=>row.uid===previous?.uid && row.region===previous.region) ? previous.uid : roles.reduce((best,row)=>!best || row.level>best.level ? row : best,null)?.uid;
  ctx.vault.saveAccountBinding({unifiedUserId:ctx.event.unifiedUserId,platform:ctx.event.platform,originalId:ctx.event.sender?.id,providerId:"mihoyo",accountKey,gameId:"zzz",cookies:{ck:cookie},device,roles,activeUid});
  const active=ctx.vault.getActiveRole(ctx.event.unifiedUserId,"zzz");
  const lines=[title("绝区零通行证绑定成功"),divider(),"检测到 "+roles.length+" 个角色："];
  roles.forEach((r,index)=>lines.push((index+1)+". "+r.nickname+" ["+r.uid+"] Lv."+r.level+(active?.uid===r.uid?" ★ 当前主角色":"")));
  lines.push(divider(),command(ctx,"listRoles")+"  "+command(ctx,"note"));
  await ctx.event.reply(lines.join("\n"));
}
