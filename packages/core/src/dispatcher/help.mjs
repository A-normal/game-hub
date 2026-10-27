/** Read-only command help shared by plugins; metadata remains owned by each plugin. */
export async function replyCommandHelp(ctx, {title, common = [], pageSize = 14, note = ""}) {
  const plugin = ctx.dispatcher.plugins.get(ctx.pluginId);
  const groups = new Map();
  for (const route of plugin.routes.filter(row => (!row.stage || row.stage === "command") && row.tokens?.some(Boolean))) {
    const group = route.help?.group || "其它";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(route);
  }
  const routes = [...groups.values()].flat();
  const command = (routeId, args = []) => ctx.commands.format({routeId, args});
  const query = ctx.args.join(" ").trim();
  const footer = ["详细用法：" + command("help", ["<指令>"]), "完整清单：" + command("help", ["全部", "[页码]"])];
  if (query && ctx.args[0] !== "全部") {
    const candidate = ctx.dispatcher.resolveNamespaceCandidates(query).find(row => row.gameId === ctx.pluginId);
    const token = candidate?.commandText ?? query;
    const route = routes.find(row => row.tokens.includes(token));
    if (!route) {
      await ctx.event.reply(["未找到该指令的帮助，请使用当前指令名称。", ...footer].join("\n"));
      return;
    }
    const info = route.help || {};
    const usages = info.usages || [info.args || []];
    const lines = ["【" + command(route.id) + "】", route.description || "", "作用范围：" + (info.scope || "当前用户"), "用法：", ...usages.map(args => "  " + command(route.id, args))];
    lines.push(...(info.details || []));
    if (info.examples?.length) lines.push("示例：", ...info.examples.map(args => "  " + command(route.id, args)));
    if (info.related?.length) lines.push("相关指令：", ...info.related.map(id => "  " + command(id)));
    await ctx.event.reply(lines.join("\n"));
    return;
  }
  const full = ctx.args[0] === "全部";
  if (full && (ctx.args.length > 2 || ctx.args[1] && !/^[1-9]\d*$/.test(ctx.args[1]))) {
    await ctx.event.reply(["页码应为正整数。", ...footer].join("\n"));
    return;
  }
  const total = Math.max(1, Math.ceil(routes.length / pageSize));
  const requested = /^\d+$/.test(ctx.args[1] || "") ? Number(ctx.args[1]) : 1;
  const page = Math.max(1, Math.min(total, requested));
  const entries = full ? routes.slice((page - 1) * pageSize, page * pageSize) : common.map(id => routes.find(row => row.id === id)).filter(Boolean);
  const lines = ["【" + title + "】", full ? "第 " + page + " / " + total + " 页；共 " + routes.length + " 条指令" : "常用指令（每项保留一个名称）"];
  let group;
  for (const route of entries) {
    const nextGroup = route.help?.group || "其它";
    if (full && nextGroup !== group) { group = nextGroup; lines.push("", "· " + group); }
    lines.push(command(route.id, route.help?.args || []) + " — " + route.description);
  }
  if (full && page < total) lines.push("下一页：" + command("help", ["全部", String(page + 1)]));
  if (note) lines.push("", note);
  lines.push("", ...footer);
  await ctx.event.reply(lines.join("\n"));
}
