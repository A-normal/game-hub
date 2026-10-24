/**
 * @file packages/plugin-zzz/src/handlers/bind.mjs
 * @description 处理绝区零通行证绑定指令 (*绑定 <cookie>)
 */

export async function handleBind(ctx) {
  const cookieStr = ctx.args.join(" ").trim();

  if (!cookieStr || (!cookieStr.includes("ltuid=") && !cookieStr.includes("account_id=") && !cookieStr.includes("cookie_token="))) {
    await ctx.event.reply(
      "【绝区零绑定】请提供有效的米游社Cookie凭据。\n" +
      "指令格式：*绑定 ltuid=123456; ltoken=xxxx;\n" +
      "（建议在私聊中发送以保护您的凭据安全）",
      { quote: true }
    );
    return "return";
  }

  // 提取通行证唯一主键 accountKey
  const ltuidMatch = cookieStr.match(/ltuid=(\d+)/) || cookieStr.match(/account_id=(\d+)/) || cookieStr.match(/account_mid_v2=([^;]+)/);
  const accountKey = ltuidMatch ? ltuidMatch[1] : `acc-${Date.now()}`;

  // 使用当前输入的 Cookie 实例化临时驱动客户端，调用米哈游角色查询接口
  const tempClient = ctx.provider.createClient(cookieStr);
  let rawRoles = [];

  try {
    rawRoles = await tempClient.getUserGameRoles("nap_cn");
  } catch (err) {
    await ctx.event.reply(`【绝区零绑定失败】无法通过该Cookie获取游戏角色: ${err.message}`, { quote: true });
    return "return";
  }

  if (!Array.isArray(rawRoles) || rawRoles.length === 0) {
    await ctx.event.reply("【绝区零绑定】未在此米游社账号下检测到绝区零角色，请确认已在游戏中创建角色并进入过游戏。", { quote: true });
    return "return";
  }

  // 1. 存入身份保密库 (使用 ON CONFLICT DO UPDATE 确保重跑不删除已有关系，解决 P0-01)
  ctx.vault.saveCredential("mihoyo", accountKey, { ck: cookieStr }, {});

  // 2. 绑定当前聊天平台用户主体
  ctx.vault.bindUser(ctx.event.unifiedUserId, ctx.event.platform, ctx.event.sender.id, "mihoyo", accountKey);

  // 3. 录入游戏角色并自动激活首个角色 (解决 P1-06)
  const roleList = rawRoles.map(r => ({
    uid: String(r.game_uid),
    region: r.region || "prod_gf_cn",
    nickname: r.nickname || "绳匠",
    level: Number(r.level || 0)
  }));
  ctx.vault.saveRoles("mihoyo", accountKey, "zzz", roleList);

  // 4. 查询当前最终激活的主角色
  const activeRole = ctx.vault.getActiveRole(ctx.event.unifiedUserId, "zzz");

  const lines = [
    `【绝区零】通行证绑定成功！`,
    `检测到 ${roleList.length} 个绑定的绳匠角色：`
  ];

  roleList.forEach((r, idx) => {
    const isCur = activeRole && activeRole.uid === r.uid;
    lines.push(`${idx + 1}. [${r.uid}] ${r.nickname} (Lv.${r.level}) ${isCur ? "★[当前主角色]" : ""}`);
  });

  lines.push("");
  lines.push("💡 提示：");
  lines.push("• 发送 *便签 或 *体力 查询电量恢复");
  lines.push("• 发送 *选角色 <uid> 可随时切换主角色");

  await ctx.event.reply(lines.join("\n"), { quote: true });
  return "return";
}

export default handleBind;
