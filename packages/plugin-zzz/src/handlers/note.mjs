/**
 * @file packages/plugin-zzz/src/handlers/note.mjs
 * @description 处理绝区零实时便签查询指令 (*便签 / *体力 / *电量)
 * 采用文本优先与清晰自适应格式，彻底杜绝单 Page 截图并发竞态 (解决 P1-04)
 */

export async function handleNote(ctx) {
  // 1. 检查是否存在激活的角色 (解决 P1-06)
  if (!ctx.activeRole) {
    await ctx.event.reply(
      "【绝区零便签】未检测到已激活的绝区零角色！\n" +
      "• 若尚未绑定，请发送：*绑定 <米游社Cookie>\n" +
      "• 若已绑定多个角色，请发送：*选角色 <uid>",
      { quote: true }
    );
    return "return";
  }

  const { uid, region, nickname } = ctx.activeRole;

  // 2. 通过注入的米游社受保护客户端发起请求 (解决 P1-03)
  let noteData;
  try {
    noteData = await ctx.client.getDailyNote(uid, region);
  } catch (err) {
    await ctx.event.reply(
      `【绝区零便签】查询失败：${err.message || "未知错误"}\n` +
      `如凭据已失效，请重新发送 *绑定 <新Cookie> 刷新。`,
      { quote: true }
    );
    return "return";
  }

  // 3. 业务数据格式化
  const energy = noteData.energy || {};
  const vitality = noteData.vitality || {};
  const restoreSec = Number(energy.restore_time || 0);

  let restoreText = "已回满";
  if (restoreSec > 0) {
    const hours = Math.floor(restoreSec / 3600);
    const mins = Math.floor((restoreSec % 3600) / 60);
    restoreText = hours > 0 ? `约需 ${hours}小时${mins}分` : `约需 ${mins}分钟`;
  }

  // 录像店营业状态
  const vhsStatus = noteData.vhs_sale?.sale_state === "SaleStateDone" ? "收益待收取" : "营业中";
  // 报刊亭刮刮卡
  const cardStatus = noteData.card_sign === "CardSignDone" ? "今日已刮取" : "未刮取";

  const lines = [
    `=== 【绝区零·实时便签】 ===`,
    `绳匠: ${nickname} (UID: ${uid})`,
    `-------------------------`,
    `⚡ 实时电量: ${energy.current ?? 0} / ${energy.max ?? 240} (${restoreText})`,
    `🔋 每日活跃: ${vitality.current ?? 0} / ${vitality.max ?? 500}`,
    `📼 录像店: ${vhsStatus}`,
    `🎟 刮刮乐: ${cardStatus}`
  ];

  if (noteData.weekly_tower) {
    lines.push(`🏛 式舆防卫战: ${noteData.weekly_tower.cur_point || 0}星`);
  }

  await ctx.event.reply(lines.join("\n"), { quote: true });
  return "return";
}

export default handleNote;
