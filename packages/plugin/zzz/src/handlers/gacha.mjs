import { command, requireRole, page, problem, shown } from "../text.mjs";
import { title, divider, section, list, pager } from "../layout.mjs";
import { storeFor } from "../storage.mjs";
import { syncGacha, parseGachaLink, gachaStatistics } from "../gacha.mjs";
const defaultInflight = new Set();
export async function handleGacha(ctx) {
  // 导入走服务器侧一次性迁移：QQ 渠道无法承载「文字+文件」，长 JSON 也不能作为正文发送。
  if (ctx.routeId === "gachaImport") {
    await ctx.event.reply([
      title("绝区零调频导入"),
      "聊天内不再解析导入文件：QQ 渠道不支持「文字+文件」消息，UIGF/SRGF 也无法作为消息正文发送。",
      divider(),
      "一次性迁移请在服务器执行（与自动同步写入同一账号范围）：",
      "  node tools/import-gacha.mjs <导出的JSON文件> <聊天用户ID> <游戏UID> [数据库路径]",
      "当前聊天用户：" + ctx.event.unifiedUserId,
      ctx.activeRole ? "当前角色 UID：" + ctx.activeRole.uid : "当前尚未激活角色，可省略的 UID 请先选择主角色。",
      "日常同步请使用「" + command(ctx, "gachaUpdate") + "」自动拉取官方记录。"
    ].join("\n"));
    return;
  }
  const role = await requireRole(ctx,"绝区零调频"); if (!role) return;
  const store = storeFor(ctx); const owner = ctx.event.unifiedUserId;
  const token = ctx.routeId === "gachaLink" ? "记录链接" : ctx.matchedToken;
  if (ctx.routeId === "gachaLink") ctx.args = [ctx.event.cleanText.trim()];
  if (/更新抽卡|更新调频|刷新抽卡/.test(token) || token === "记录链接") {
    if (ctx.args[0] && ctx.event.isGroup) { await ctx.event.reply("带授权的调频链接请在私聊中提交。"); return {status:"DENIED"}; }
    const authkey = ctx.args[0] ? parseGachaLink(ctx.args[0],role) : undefined;
    const lock = owner+":"+role.region+":"+role.uid;
    const inflight = ctx.services?.gachaInflight || defaultInflight;
    if (inflight.has(lock)) throw problem("当前角色正在同步调频，请稍后查询。");
    inflight.add(lock);
    try {
      const result = await syncGacha({client:ctx.client,role,owner,store,authkey});
      await ctx.event.reply(title("绝区零调频同步") + "\n读取 " + result.fetched + " 条，新增 " + result.added + " 条。\n" + command(ctx,"gachaRecords"));
    } finally { inflight.delete(lock); }
    return;
  }
  const records = store.gacha(owner,role);
  if (token === "导出抽卡") {
    if (ctx.event.isGroup) { await ctx.event.reply("调频导出请在私聊操作。"); return {status:"DENIED"}; }
    const timezone={prod_gf_cn:8,prod_gf_jp:8,prod_gf_sg:8,prod_gf_us:-5,prod_gf_eu:1}[role.region];
    const output = JSON.stringify({info:{export_app:"Game-Hub",export_app_version:"1",export_timestamp:Math.floor(Date.now()/1000),uigf_version:"v4.0"},nap:[{uid:role.uid,timezone,list:records}]});
    if (output.length > 50000) throw problem("记录过长，暂不通过聊天正文导出；请使用仓库数据备份。");
    await ctx.event.reply(output); return;
  }
  if (!records.length) { await ctx.event.reply(title("绝区零调频") + "\n本地暂无调频记录。请使用「" + command(ctx,"gachaUpdate") + "」从当前登录账号自动同步；也可私聊附上官方记录链接。"); return; }
  const lines = [title("绝区零调频分析"), "UID " + role.uid, "范围：本地已同步记录；首个 S 之前和已过期记录可能不完整。", divider()];
  for (const stat of gachaStatistics(records)) {
    lines.push("", section(stat.name, 16));
    lines.push("  " + stat.total + " 抽；S " + stat.s + "；A " + stat.a + "；已垫 " + stat.pity + "；记录内平均 S 间隔 " + (stat.average===null?"无":stat.average.toFixed(2)));
    if (/记录/.test(token)) lines.push(...list(stat.wins.slice(-8).map(row => shown(row.name) + "：" + row.pulls + " 抽（" + row.time + "）"), { indent: "    " }));
  }
  if (ctx.args.includes("明细")) {
    const p = page([...records].reverse(),ctx.args.at(-1));
    lines.push("", section("最近记录明细", 16), ...list(p.items.map(r => r.time + " " + r.name + " 等级" + r.rank_type), { indent: "  " }), pager(p));
  }
  lines.push(divider(), "更新：" + command(ctx,"gachaUpdate"));
  await ctx.event.reply(lines.join("\n"));
}
