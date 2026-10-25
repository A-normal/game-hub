import { requireRole, command, dataEntries, dataLines, page, problem, shown } from "../text.mjs";
import { title, divider, section, pager } from "../layout.mjs";
import { storeFor } from "../storage.mjs";
import {refreshPoolHistory,PUBLIC_ROLE} from "../public-data.mjs";

const recordKinds = {card:["index","绳网资料"],avatars:["avatars","代理人"],buddies:["buddies","邦布"],abyss:["shiyu","式舆防卫战"],deadly:["deadly","危局强袭战"],holo:["holo","全息拟境"],tower:["tower","模拟鏖战试炼"],void:["void","临界推演"],hollow:["hollow","零号空洞"],hollowDetail:["hollowDetail","枯萎之都"],hollow2:["hollow2","迷失之地"],zenkov:["zenkov","绝境作战总览"],zenkovDetail:["zenkovDetail","绝境作战详情"],exploration:["exploration","探索"],calendar:["calendar","活动日历"]};
const kvLines = (rows, indent = "  ") => rows.map(([key, value]) => indent + key + ": " + value);
export async function handleRecord(ctx) {
  const spec = recordKinds[ctx.routeId] || recordKinds.abyss;
  const role = await requireRole(ctx,spec[1]); if (!role) return;
  const previous = ctx.args.includes("上期") || ctx.matchedToken.startsWith("上期");
  if(previous && !["shiyu","deadly","holo","void"].includes(spec[0]))throw problem("该模式没有上期查询接口。");
  const extra = previous ? {schedule_type:2} : {};
  const data = await ctx.client.record(spec[0],role.uid,role.region,extra);
  const store = storeFor(ctx); store.put(ctx.event.unifiedUserId,role,"record",spec[0]+":"+(previous?2:1),data);
  const lines = [title("绝区零 · "+spec[1]), role.nickname + " [" + role.uid + "]", "来源：米游社 · " + (previous ? "上期" : "当前") + "周期", divider()];
  if (data.has_data === false || data.is_unlock === false || data.is_unlocked === false || data.unlock === false) lines.push("暂无记录或尚未解锁。");
  else {
    const array = data.avatar_list || data.list || data.buddy_list;
    if (array) {
      const p = page(array,ctx.args.find(v=>/^\d+$/.test(v)));
      p.items.forEach((item,index) => {
        if (index) lines.push("");
        lines.push(section("第 " + ((p.number - 1) * 15 + index + 1) + " 项", 14));
        const rows = dataEntries(item, { budget: { left: 12 } });
        lines.push(...(rows.length ? kvLines(rows) : ["  暂无可显示的记录。"]));
      });
      lines.push("", pager(p, command(ctx,ctx.routeId,[String(p.number+1)])));
    } else {
      const rows = dataEntries(data);
      lines.push(...(rows.length ? kvLines(rows) : ["暂无可显示的记录。"]));
    }
  }
  await ctx.event.reply(lines.join("\n"));
}
export function monthKey(value, fallback = new Date()) {
  if (value === undefined || value === null || value === "") return fallback.toISOString().slice(0,7);
  const text = String(value);
  const match = /^(\d{4})[-/]?(\d{2})$/.exec(text);
  if (match && Number(match[2])>=1 && Number(match[2])<=12) return match[1]+"-"+match[2];
  if (/^(?:[1-9]|1[0-2])$/.test(text)) return fallback.getUTCFullYear()+"-"+text.padStart(2,"0");
  throw problem("月份格式应为 YYYY-MM 或 1–12。");
}
export async function handleMonthly(ctx) {
  const role = await requireRole(ctx,"绝区零月报"); if (!role) return;
  const store = storeFor(ctx); const owner=ctx.event.unifiedUserId;
  let refreshFailed=false;
  if(["monthlySummary","monthlyRefresh"].includes(ctx.routeId)) {
    try {
      const latest=await ctx.client.monthly(role.uid,role.region);
      const latestKey=monthKey(latest.data_month || latest.current_month);
      const staged=new Map([[latestKey,latest]]);
      const available=latest.optional_month || [];
      if(!Array.isArray(available) || available.length>24)throw problem("可用月报列表格式异常。");
      for(const month of available) {const key=monthKey(month);if(staged.has(key))continue;const data=await ctx.client.monthly(role.uid,role.region,key.replace("-",""));if(monthKey(data.data_month)!==key)throw problem("月报接口返回的月份不一致。");staged.set(key,data);}
      ctx.vault._transaction(()=>{for(const [key,data] of staged) {if(data.uid && String(data.uid)!==role.uid || data.region && data.region!==role.region || !data.month_data)throw problem("月报主体或内容异常，旧缓存已保留。");store.put(owner,role,"monthly",key,data);}});
    } catch(error) {if(!store.list(owner,role,"monthly").length)throw error;refreshFailed=true;}
  }
  if (["monthlySummary","monthlyRefresh"].includes(ctx.routeId)) {
    const entries = store.list(owner,role,"monthly");
    const lines = [title("绝区零月报汇总"),"自动同步官方可用月份并合并已存档历史",...(refreshFailed?["本次刷新失败，展示原缓存汇总。"]:[]),divider()];
    const totals = new Map();
    for (const entry of entries) {
      lines.push(entry.key+"："+(entry.data.month_data?.list || []).map(r=>shown(r.data_name)+" "+shown(r.count)).join(" / "));
      for (const row of entry.data.month_data?.list || []) if (Number.isFinite(Number(row.count))) totals.set(row.data_name,(totals.get(row.data_name)||0)+Number(row.count));
    }
    lines.push(...[...totals].map(([name,n])=>shown(name)+"合计："+n));
    if (!entries.length) lines.push("尚无缓存，使用「"+command(ctx,"monthly",["[YYYY-MM]"])+"」。");
    await ctx.event.reply(lines.join("\n")); return;
  }
  const requested = ctx.args[0] ? monthKey(ctx.args[0]) : undefined;
  const data = await ctx.client.monthly(role.uid,role.region,requested?.replace("-",""));
  if(data.uid && String(data.uid)!==role.uid || data.region && data.region!==role.region || !data.month_data)throw problem("月报主体或内容异常，未保存。");
  const key = monthKey(data.data_month || requested || data.current_month);
  if (requested && key !== requested) throw problem("官方返回了其它月份，未覆盖请求月份的缓存。");
  store.put(owner,role,"monthly",key,data);
  await ctx.event.reply([title("绝区零月报 · "+key),"来源：米游社月报",divider(),...dataLines(data)].join("\n"));
}
export async function handlePools(ctx) {
  if (!/当前卡池/.test(ctx.matchedToken)) {
    const store=storeFor(ctx),now=ctx.services.now?.() ?? Date.now();
    let cached=store.get("public",PUBLIC_ROLE,"public","poolHistory");let stale=false;
    if (ctx.routeId==="poolsRefresh" || !cached || now-cached.updatedAt>86400000) {
      try {await refreshPoolHistory(store,ctx.services);cached=store.get("public",PUBLIC_ROLE,"public","poolHistory");}
      catch(error) {if(!cached)throw error;stale=true;}
    }
    const query=ctx.args.filter(v=>!/^\d+$/.test(v)).join(" ");
    const rows=cached.data.rows.filter(row=>!query || JSON.stringify(row).includes(query));
    const p=page(rows,ctx.args.find(v=>/^\d+$/.test(v)),8);
    const lines=["【绝区零卡池历史】", "来源：GachaClock（MIT）/ "+cached.data.source,"抓取时间："+new Date(cached.updatedAt).toISOString()+(stale?"；刷新失败，展示原缓存":""),"来源首条记录："+cached.data.rows[0].version+" / "+cached.data.rows[0].time];
    if (/复刻/.test(ctx.matchedToken)) {
      const names=new Map();
      for (const row of rows.filter(row=>row.type==="角色")) for(const name of row.s) {const list=names.get(name)||[];list.push(row.version+" / "+row.time);names.set(name,list);}
      const summary=page([...names],ctx.args.find(v=>/^\d+$/.test(v)),10);
      for(const [name,list] of summary.items)lines.push(name+"：出现 "+list.length+" 次；"+list.join("；"));
      lines.push("第 "+summary.number+" / "+summary.total+" 页");
    } else {for(const row of p.items)lines.push(row.version+" / "+row.type+" / "+row.title,"S："+row.s.join("、")+"；A："+row.a.join("、"),row.time);lines.push("第 "+p.number+" / "+p.total+" 页");}
    if(!rows.length)lines.push("没有符合筛选条件的记录。");
    lines.push("刷新："+command(ctx,"poolsRefresh"));await ctx.event.reply(lines.join("\n"));return;
  }
  const role = await requireRole(ctx,"绝区零卡池"); if (!role) return;
  const owner=ctx.event.unifiedUserId; const store=storeFor(ctx);
  const refresh = /更新|刷新|当前/.test(ctx.matchedToken) || !store.list(owner,role,"pools").length;
  if (refresh) {
    const data = await ctx.client.record("pools",role.uid,role.region);
    const rows=[...(data.avatar_gacha_schedule_list || []),...(data.weapon_gacha_schedule_list || []),...(data.gacha_schedule_list || [])];
    if (!rows.length) throw problem("官方暂未返回卡池安排，原缓存已保留。");
    ctx.vault._transaction(()=>{ for (const row of rows) {
      const key = String(row.gacha_id || row.id || "")+":"+String(row.begin_time || row.start_time || "")+":"+String(row.gacha_name || row.name || "");
      if (key === "::") throw problem("官方卡池记录缺少标识。");
      store.put(owner,role,"pools",key,row);
    }});
  }
  let rows=store.list(owner,role,"pools");
  const filter=ctx.args.filter(v=>!/^\d+$/.test(v)).join(" ");
  if (filter) rows=rows.filter(row=>JSON.stringify(row.data).includes(filter));
  const p=page(rows,ctx.args.find(v=>/^\d+$/.test(v)),8);
  const lines=["【绝区零当前卡池安排】来源：米游社官方活动日历。"];
  for (const row of p.items) lines.push(...dataLines(row.data));
  lines.push("第 "+p.number+" / "+p.total+" 页；可按版本或角色名筛选。", "刷新："+command(ctx,"poolsRefresh"));
  if (/复刻/.test(ctx.matchedToken)) {
    const counts=new Map(); for (const row of rows) {
      for (const avatar of row.data.avatar_list || row.data.up_avatar_list || []) { const name=avatar.full_name || avatar.name || avatar.id; counts.set(name,(counts.get(name)||0)+1); }
    }
    lines.push("缓存中出现次数：",...[...counts].map(([name,count])=>shown(name)+": "+count));
  }
  await ctx.event.reply(lines.join("\n"));
}
