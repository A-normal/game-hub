import { title, section, pager } from "../layout.mjs";

// 分组只影响展示顺序，不改变任何路由或权限。
const GROUPS = [
  ["本手册", ["help"]],
  ["账号与登录", ["loginQr", "loginCancel", "bind", "unbind", "selectRole", "listRoles"]],
  ["面板与养成", ["panelRefresh", "showcaseRefresh", "panelList", "showcase", "panel", "proficiency", "score", "weights", "mainstats", "conditions", "damage"]],
  ["战绩", ["card", "avatars", "buddies", "abyss", "deadly", "holo", "tower", "void", "hollow", "hollowDetail", "hollow2", "zenkov", "zenkovDetail", "exploration", "calendar"]],
  ["抽卡与月报", ["gachaUpdate", "gachaRecords", "gachaAnalysis", "gachaImport", "gachaExport", "pools", "poolsRefresh", "monthly", "monthlySummary", "monthlyRefresh"]],
  ["日常与提醒", ["note", "sign", "signStatus", "autoSign", "energyReminder", "challengeReminder", "tasks"]],
  ["群排名", ["rank", "rankGroup", "rankPublish", "rankWithdraw", "rankPrivacy", "rankReset"]],
  ["内容与攻略", ["guide", "skills", "codes"]],
  ["设置与维护", ["device", "deviceDefault", "aliases", "cooldown", "cacheClean", "calculationSettings"]]
];
const PAGE_SIZE = 14;

export async function handleHelp(ctx) {
  const plugin = ctx.dispatcher.plugins.get(ctx.pluginId);
  const routes = new Map(plugin.routes
    .filter(row => (!row.stage || row.stage === "command") && row.tokens?.some(Boolean))
    .map(row => [row.id, row]));
  const entries = [];
  const seen = new Set();
  for (const [group, ids] of GROUPS) {
    for (const id of ids) {
      const route = routes.get(id);
      if (!route || seen.has(id)) continue;
      seen.add(id);
      entries.push({ group, route });
    }
  }
  for (const [id, route] of routes) if (!seen.has(id)) entries.push({ group: "其它", route });

  const total = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const requested = Number.parseInt(ctx.args.find(value => /^\d+$/.test(value)), 10) || 1;
  const number = Math.min(total, Math.max(1, requested));
  const slice = entries.slice((number - 1) * PAGE_SIZE, number * PAGE_SIZE);
  const example = ctx.commands.format({ routeId: "note" });
  const lines = [title("绝区零命令手册"), "共 " + entries.length + " 条；前缀与别名独立使用，例如「" + example + "」。"];
  let group = "";
  for (const entry of slice) {
    if (entry.group !== group) {
      group = entry.group;
      lines.push("", section(group));
    }
    lines.push(ctx.commands.format({ routeId: entry.route.id }) + " — " + (entry.route.description || ""));
  }
  if (total > 1) lines.push("", pager({ number, total, items: slice }, ctx.commands.format({ routeId: "help", args: [String(Math.min(total, number + 1))] })));
  await ctx.event.reply(lines.join("\n"));
}
