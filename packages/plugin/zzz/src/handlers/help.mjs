export async function handleHelp(ctx) {
  const plugin=ctx.dispatcher.plugins.get(ctx.pluginId);
  const lines=["【绝区零纯文本命令】"];
  for (const route of plugin.routes.filter(row=>(!row.stage || row.stage==="command") && row.tokens?.length)) lines.push(ctx.commands.format({routeId:route.id})+" — "+route.description);
  await ctx.event.reply(lines.join("\n"));
}
