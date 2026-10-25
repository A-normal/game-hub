import { command, requireRole, page, problem, shown } from "../text.mjs";
import { storeFor } from "../storage.mjs";
import { syncGacha, importGacha, parseGachaLink, gachaStatistics } from "../gacha.mjs";
export async function handleGacha(ctx) {
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
      await ctx.event.reply("调频同步完成：读取 "+result.fetched+" 条，新增 "+result.added+" 条。\n"+command(ctx,"gachaRecords"));
    } finally { inflight.delete(lock); }
    return;
  }
  if (token === "导入抽卡") {
    if (ctx.event.isGroup) { await ctx.event.reply("调频数据请在私聊导入。"); return {status:"DENIED"}; }
    const text = ctx.args.join(" "); if (text.length > 5000000) throw problem("导入文件过大。");
    const records = importGacha(text,role);
    const added = store.importGacha(owner,role,records);
    await ctx.event.reply("辅助导入完成：新增 "+added+" 条。\n自动更新："+command(ctx,"gachaUpdate")); return;
  }
  const records = store.gacha(owner,role);
  if (token === "导出抽卡") {
    if (ctx.event.isGroup) { await ctx.event.reply("调频导出请在私聊操作。"); return {status:"DENIED"}; }
    const timezone={prod_gf_cn:8,prod_gf_jp:8,prod_gf_sg:8,prod_gf_us:-5,prod_gf_eu:1}[role.region];
    const output = JSON.stringify({info:{export_app:"Game-Hub",export_app_version:"1",export_timestamp:Math.floor(Date.now()/1000),uigf_version:"v4.0"},nap:[{uid:role.uid,timezone,list:records}]});
    if (output.length > 50000) throw problem("记录过长，暂不通过聊天正文导出；请使用仓库数据备份。");
    await ctx.event.reply(output); return;
  }
  if (!records.length) { await ctx.event.reply("本地暂无调频记录。请使用「"+command(ctx,"gachaUpdate")+"」从当前登录账号自动同步；也可私聊附上官方记录链接。"); return; }
  const lines = ["【绝区零调频分析】"+role.uid,"范围：本地已同步记录；首个 S 之前和已过期记录可能不完整。"];
  for (const stat of gachaStatistics(records)) {
    lines.push(stat.name+": "+stat.total+" 抽；S "+stat.s+"；A "+stat.a+"；已垫 "+stat.pity+"；记录内平均 S 间隔 "+(stat.average===null?"无":stat.average.toFixed(2)));
    if (/记录/.test(token)) for (const row of stat.wins.slice(-8)) lines.push("  "+shown(row.name)+"："+row.pulls+" 抽（"+row.time+"）");
  }
  if (ctx.args.includes("明细")) {
    const p = page([...records].reverse(),ctx.args.at(-1)); lines.push("明细 "+p.number+"/"+p.total,...p.items.map(r=>r.time+" "+r.name+" 等级"+r.rank_type));
  }
  lines.push("更新："+command(ctx,"gachaUpdate")); await ctx.event.reply(lines.join("\n"));
}
const defaultInflight = new Set();
