import { requireRole, command, problem } from "../text.mjs";
import { storeFor } from "../storage.mjs";
export async function handleCalculationSettings(ctx) {
  const store=storeFor(ctx),owner=ctx.event.unifiedUserId;
  if(!ctx.args.length) {await ctx.event.reply("【个人计算场景】\n"+JSON.stringify(store.option(owner,"calculationScenario",{}))+"\n"+command(ctx,"calculationSettings",["<场景JSON|重置>"]));return;}
  if(ctx.args[0]==="重置") {store.setOption(owner,"calculationScenario",{});await ctx.event.reply("已恢复默认靶场场景。");return;}
  let value;try {value=JSON.parse(ctx.args.join(" "));}catch {throw problem("场景必须为有效 JSON。");}
  const {validateScenario}=await import("../calculation.mjs");value=validateScenario(value);
  store.setOption(owner,"calculationScenario",value);await ctx.event.reply("个人计算场景已保存。\n"+command(ctx,"damage",["<角色名/ID>"]));
}
export async function handleAlias(ctx) {
  const store=storeFor(ctx),owner=ctx.event.unifiedUserId,aliases=store.option(owner,"aliases",{});
  if (ctx.matchedToken==="删除别名") { delete aliases[ctx.args[0]]; store.setOption(owner,"aliases",aliases); await ctx.event.reply("已删除该个人别名。"); return; }
  if (!ctx.args.length) { await ctx.event.reply("【个人角色别名】\n"+Object.entries(aliases).map(([k,v])=>k+" → "+v).join("\n")+"\n"+command(ctx,"aliases",["<别名>","<完整角色名/ID>"])); return; }
  if (ctx.args.length<2 || ctx.args.some(v=>v.length>80 || /[\[\]\r\n]/.test(v))) throw problem("请提供有效的别名和完整角色名或 ID。");
  aliases[ctx.args[0]]=ctx.args.slice(1).join(" "); store.setOption(owner,"aliases",aliases); await ctx.event.reply("个人角色别名已保存。");
}
export async function handleTasks(ctx) {
  const role=await requireRole(ctx); if (!role) return;
  const tasks=ctx.services.tasks;
  if (!tasks) throw problem("任务调度器未装配，请检查插件生命周期配置。");
  const owner=ctx.event.unifiedUserId;
  if (ctx.routeId==="tasks") {
    const rows=storeFor(ctx).jobs(owner); await ctx.event.reply("【绝区零任务状态】\n"+(rows.length?rows.map(job=>job.kind+" / "+job.uid+"："+(job.enabled?"开启":"关闭")+"；下次 "+new Date(job.nextRun).toISOString()).join("\n"):"未配置自动任务。默认全部关闭。")); return;
  }
  const kind=ctx.routeId==="autoSign"?"sign":ctx.routeId==="energyReminder"?"energy":"challenge";
  const input=ctx.args[0];
  if (!["开启","关闭","on","off"].includes(input)) { await ctx.event.reply("用法："+command(ctx,ctx.routeId,["<开启|关闭>",kind==="energy"?"[电量阈值]":kind==="challenge"?"[提前小时]":""])); return; }
  // Sign notifications are private. Group reminders require group administrator consent.
  if (ctx.event.isGroup && (kind==="sign" || !["owner","admin"].includes(ctx.event.sender?.role) && !ctx.dispatcher.isAdmin(ctx.event))) { await ctx.event.reply(kind==="sign"?"自动签到请在私聊中配置。":"群提醒仅限群管理员配置。"); return {status:"DENIED"}; }
  const n=ctx.args[1]===undefined?undefined:Number(ctx.args[1]);
  if (n!==undefined && (!Number.isFinite(n) || n<=0 || n> (kind==="energy"?10000:168))) throw problem("提醒阈值超出支持范围。");
  const target={platform:ctx.event.platform,botId:ctx.event.botId,userId:ctx.event.sender.id,isGroup:ctx.event.isGroup,groupId:ctx.event.groupId};
  const settings=kind==="energy"?{...(n===undefined?{}:{threshold:n}),intervalMinutes:60}:kind==="challenge"?{hours:n || 24,mode:ctx.args[2]==="危局"?"deadly":"shiyu",intervalMinutes:60}:{};
  const job=tasks.configure({owner,role,kind,target,settings,enabled:["开启","on"].includes(input)});
  await ctx.event.reply("任务已"+(job.enabled?"开启":"关闭")+"；"+command(ctx,"tasks"));
}
export async function handleRanking(ctx) {
  const store=storeFor(ctx),owner=ctx.event.unifiedUserId;
  if (ctx.routeId==="rankPrivacy") { const hidden=ctx.args[0]!=="公开"; store.setOption(owner,"rankHidden",hidden); await ctx.event.reply(hidden?"已隐藏您在所有群榜单中的记录。":"已恢复已授权榜单记录的展示。"); return; }
  if (!ctx.event.isGroup) throw problem("群排名请在目标群中操作。");
  const group=ctx.event.platform+":"+ctx.event.groupId;
  const admin=["owner","admin"].includes(ctx.event.sender?.role) || ctx.dispatcher.isAdmin(ctx.event);
  if (ctx.routeId==="rankGroup") {
    if (!admin) {await ctx.event.reply("仅群管理员可以配置群排名。");return {status:"DENIED"};}
    if (!["开启","关闭"].includes(ctx.args[0])) throw problem("请选择开启或关闭群排名。");
    store.setOption(group,"rankEnabled",ctx.args[0]==="开启"); await ctx.event.reply("群排名设置已保存。"); return;
  }
  if (ctx.routeId==="rankReset") { if (!admin) {await ctx.event.reply("仅群管理员可以重置排名。");return {status:"DENIED"};} store.clearRanking(group); await ctx.event.reply("当前群排名已清空。"); return; }
  if (!store.option(group,"rankEnabled",false)) throw problem("当前群尚未开启排名，请由群管理员配置。");
  const category=ctx.args[0]==="危局"?"deadly":"shiyu";
  if (ctx.routeId==="rankPublish") {
    const role=await requireRole(ctx); if (!role) return;
    const data=store.get(owner,role,"record",category+":1")?.data;
    const body=data?.hadal_info_v2 || data?.hadal_mem_detail_v2 || data;
    const score=Number(body?.total_score ?? body?.total_star ?? body?.star_num);
    if (!Number.isFinite(score)) throw problem("请先查询当前周期的对应战绩，再主动提交排名。");
    store.publish(group,owner,role,category,score); await ctx.event.reply("已授权在当前群展示该角色的 "+category+" 战绩。"); return;
  }
  if (ctx.routeId==="rankWithdraw") { store.clearRanking(group,owner); await ctx.event.reply("已撤回您在当前群的排名记录。"); return; }
  const rows=store.rankings(group,category);
  await ctx.event.reply("【群排名 · "+category+"】仅展示当前群主动授权的缓存战绩\n"+(rows.length?rows.map((row,i)=>(i+1)+". "+row.nickname+" ["+row.uid+"] "+row.score).join("\n"):"暂无已授权记录。"));
}
