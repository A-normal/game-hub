/**
 * @file packages/plugin-zzz/src/handlers/role.mjs
 * @description 处理绝区零角色选择与切换指令 (*选角色 <uid> / *角色列表)
 */

export async function handleSelectRole(ctx) {
  const targetUid = ctx.args[0]?.trim();

  if (!targetUid) {
    await ctx.event.reply(
      "【绝区零选角色】请提供要切换的目标UID。\n" +
      "指令格式：*选角色 17708598\n" +
      "提示：可发送 *角色列表 查看您已绑定的全部角色。",
      { quote: true }
    );
    return "return";
  }

  const success = ctx.vault.setActiveRole(ctx.event.unifiedUserId, "zzz", targetUid);

  if (success) {
    const active = ctx.vault.getActiveRole(ctx.event.unifiedUserId, "zzz");
    await ctx.event.reply(
      `【绝区零】已成功将主角色切换为：\n` +
      `• [${active.uid}] ${active.nickname} (Lv.${active.level})\n` +
      `后续发送 *便签 等指令将默认查询该角色的数据。`,
      { quote: true }
    );
  } else {
    await ctx.event.reply(
      `【绝区零】切换失败：未找到归属于您的角色 UID [${targetUid}]。\n` +
      `请发送 *角色列表 确认您已绑定的角色，或发送 *绑定 添加新通行证。`,
      { quote: true }
    );
  }

  return "return";
}

export async function handleListRoles(ctx) {
  const roles = ctx.vault.getUserRoles(ctx.event.unifiedUserId, "zzz");

  if (!Array.isArray(roles) || roles.length === 0) {
    await ctx.event.reply(
      "【绝区零角色列表】您当前尚未绑定任何绝区零账号。\n" +
      "请先发送 *绑定 <米游社Cookie> 绑定您的账号。",
      { quote: true }
    );
    return "return";
  }

  const lines = [
    `【绝区零】您当前已绑定的绳匠角色列表 (${roles.length}个)：`
  ];

  roles.forEach((r, idx) => {
    const activeTag = r.is_active ? " ★[当前主角色]" : "";
    lines.push(`${idx + 1}. [${r.uid}] ${r.nickname} (Lv.${r.level})${activeTag}`);
  });

  lines.push("");
  lines.push("💡 切换指令：*选角色 <uid>");

  await ctx.event.reply(lines.join("\n"), { quote: true });
  return "return";
}
