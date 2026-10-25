export const command = (ctx, routeId, args = []) => ctx.commands.format({ routeId, args });
export function problem(message) { return Object.assign(new Error(message), { publicMessage: message }); }
export async function requireRole(ctx, label = "绝区零") {
  if (ctx.activeRole) return ctx.activeRole;
  await ctx.event.reply("【" + label + "】未检测到已激活的绝区零角色。请使用「" + command(ctx,"loginQr") + "」登录，或「" + command(ctx,"selectRole",["<UID>"]) + "」选择角色。");
  return null;
}
export function plain(value, max = 3500) { return String(value ?? "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?\s*>/gi,"\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#(\d+);/g,(_,n) => Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : "").slice(0,max); }
export const shown = value => value === undefined || value === null || value === "" ? "未返回" : plain(value,200);
export function page(items, requested = 1, size = 15) { const total = Math.max(1,Math.ceil(items.length/size)); const number = Math.min(total,Math.max(1,Number.parseInt(requested,10)||1)); return { items: items.slice((number-1)*size,number*size), number, total }; }
const labels = { uid:"UID", nickname:"昵称", level:"等级", name:"名称", score:"得分", total_score:"总分", max_score:"最高分", rank:"评级", rating:"评级", max_layer:"最高层", max_floor:"最高层", total_star:"星数", star:"星数", star_num:"星数", time:"时间", total_time:"总耗时", battle_time:"战斗耗时", floor:"层数", layer:"层数", index:"序号", title:"标题", desc:"说明", description:"说明", start_time:"开始", end_time:"结束", period:"周期", schedule_id:"周期ID", schedule_type:"周期类型", cur_point:"当前积分", max_point:"积分上限", progress:"进度", count:"数量", num:"数量", value:"数值", avatar_num:"代理人数", buddy_num:"邦布数", achievement_count:"成就", active_days:"活跃天数", world_level_name:"绳网称号", full_name:"名称", rarity:"稀有度", role_name:"角色", property_name:"属性", final:"最终属性", is_unlock:"已解锁", has_data:"有记录", is_full:"已完成", completed:"已完成", finish:"已完成", medal_name:"勋章", data_name:"分类", data_type:"分类ID", month:"月份", month_data:"月度数据", total:"合计" };
// Render only real scalar data, with a depth/length budget. URLs and credentials never enter reports.
export function dataLines(value, { depth = 0, prefix = "", budget = { left: 80 } } = {}) {
  if (!value || typeof value !== "object" || depth > 7 || budget.left <= 0) return [];
  const lines = [];
  for (const [key,item] of Object.entries(value)) {
    if (budget.left <= 0) break;
    if (/icon|image|url|cookie|token|authkey|ticket|device|account/i.test(key)) continue;
    const label = labels[key] || plain(key,60);
    if (item && typeof item === "object") {
      const children = dataLines(item,{ depth:depth+1,prefix:prefix+label+" / ",budget }); lines.push(...children);
    } else if (["string","number","boolean"].includes(typeof item) && String(item).length && !/^https?:/i.test(String(item))) {
      lines.push(prefix+label+": "+shown(item)); budget.left--;
    }
  }
  return lines;
}
