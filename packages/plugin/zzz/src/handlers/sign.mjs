import {requireRole,problem,command} from "../text.mjs";
export async function handleSign(ctx) {
  const role=await requireRole(ctx,"绝区零签到"); if (!role) return;
  const info=await ctx.client.signInfo(role.uid,role.region);
  if (ctx.routeId==="signStatus" || info.is_sign) { await ctx.event.reply("【绝区零签到】"+(info.is_sign?"今日已签到":"今日尚未签到")+"；本月累计 "+(info.total_sign_day ?? "未返回")+" 天。"); return; }
  const result=await ctx.client.sign(role.uid,role.region);
  if (result.gt_result?.risk_code || result.risk_code) throw problem("签到需要安全验证，请在米游社客户端完成验证。");
  const confirmed=await ctx.client.signInfo(role.uid,role.region);
  if (!confirmed.is_sign) throw problem("签到结果尚未确认，请稍后查询「"+command(ctx,"signStatus")+"」。");
  await ctx.event.reply("【绝区零签到】签到成功；本月累计 "+(confirmed.total_sign_day ?? "未返回")+" 天。");
}
