import { requireRole, problem, command } from "../text.mjs";
import { title, divider, kv } from "../layout.mjs";
const summary = (role, info, extra = []) => [
  title("绝区零签到"),
  role.nickname + " [" + role.uid + "]",
  divider(),
  ...kv([["今日", info.is_sign ? "已签到" : "尚未签到"], ["本月累计", info.total_sign_day === undefined ? "" : info.total_sign_day + " 天"], ...extra]),
  divider()
];
export async function handleSign(ctx) {
  const role = await requireRole(ctx,"绝区零签到"); if (!role) return;
  const info = await ctx.client.signInfo(role.uid,role.region);
  if (ctx.routeId === "signStatus" || info.is_sign) {
    const next = info.is_sign ? command(ctx,"tasks") : command(ctx,"sign");
    await ctx.event.reply([...summary(role, info), "下一步：" + next].join("\n"));
    return;
  }
  const result = await ctx.client.sign(role.uid,role.region);
  if (result.gt_result?.risk_code || result.risk_code) throw problem("签到需要安全验证，请在米游社客户端完成验证。");
  const confirmed = await ctx.client.signInfo(role.uid,role.region);
  if (!confirmed.is_sign) throw problem("签到结果尚未确认，请稍后查询「" + command(ctx,"signStatus") + "」。");
  await ctx.event.reply([
    ...summary(role, confirmed, [["本次", "签到成功"]]),
    "下一步：" + command(ctx,"signStatus") + " / " + command(ctx,"tasks")
  ].join("\n"));
}
