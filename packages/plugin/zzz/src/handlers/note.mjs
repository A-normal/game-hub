/**
 * @file packages/plugin/zzz/src/handlers/note.mjs
 * @description 绝区零实时便签（电量/活跃度/录像店/刮刮卡/恶名狩猎/空洞调查）
 */

import { requireRole, shown, plain, dataLines, command } from "../text.mjs";
import { title, divider, bar, humanDuration, clockAt } from "../layout.mjs";

const VHS_STATES = {
  SaleStateDoing: "营业中 ⏳",
  SaleStateDone: "营业结束（待结算领取）🎉",
  SaleStateNone: "尚未营业（建议上架录像带）⚠️"
};

const CARD_STATES = {
  CardSignDone: "今日已刮奖 ✅",
  CardSignNone: "今日尚未刮奖（咆哮黑洞）⚠️",
  CardSignDoing: "刮奖进行中 ⏳"
};

export async function handleNote(ctx) {
  const role = await requireRole(ctx, "绝区零便签");
  if (!role) return;

  const data = await ctx.client.getDailyNote(role.uid, role.region);
  const now = ctx.services?.now ? ctx.services.now() : Date.now();
  const lines = [
    title("绝区零 · 实时便签"),
    role.nickname + " [" + role.uid + "]",
    "来源：米游社实时便签",
    divider()
  ];

  // 1. 实时电量
  if (data.energy) {
    const e = data.energy.progress || data.energy;
    const cur = Number(e.current ?? 0);
    const max = Number(e.max ?? 240);
    const restore = Number(data.energy.restore ?? data.energy.restore_time ?? 0);
    const isFull = cur >= max;
    const gauge = bar(cur, max, 10);

    let energyLine = `⚡ 实时电量: ${cur} / ${max} ${gauge}`;
    if (isFull) {
      energyLine += " (已回满)";
    }
    lines.push(energyLine);

    if (!isFull && restore > 0) {
      lines.push(`   ⏳ 预计回满: ${clockAt(restore, now)} (还需 ${humanDuration(restore)})`);
    }
  }

  // 2. 每日活跃度
  const vitality = data.vitality?.progress || data.vitality;
  if (vitality && vitality.current !== undefined && vitality.max !== undefined) {
    const curV = Number(vitality.current);
    const maxV = Number(vitality.max);
    const isVFull = curV >= maxV;
    lines.push(`🎯 每日活跃: ${curV} / ${maxV} ${bar(curV, maxV, 8)}${isVFull ? " ✅" : ""}`.trimEnd());
  }

  // 3. 录像店营业状态
  if (data.vhs_sale) {
    const state = data.vhs_sale.sale_state;
    const desc = VHS_STATES[state] || plain(state, 50);
    lines.push(`🎬 录像店经营: ${desc}`);
  }

  // 4. 丽都导览刮刮卡
  if (data.card_sign !== undefined) {
    const state = typeof data.card_sign === "string" ? data.card_sign : (data.card_sign?.sign_state || "");
    const desc = CARD_STATES[state] || plain(state, 50);
    lines.push(`🎫 报刊亭刮卡: ${desc}`);
  }

  // 5. 恶名狩猎剩余次数
  if (data.bounty_commission) {
    const b = data.bounty_commission;
    const num = Number(b.num ?? 0);
    const total = Number(b.total ?? 3);
    lines.push(`👾 恶名狩猎: 剩余 ${num} / ${total} 次${num === 0 ? " (本周已耗尽)" : ""}`);
  }

  // 6. 零号空洞调查点数
  if (data.survey_points) {
    const s = data.survey_points;
    const num = Number(s.num ?? 0);
    const total = Number(s.total ?? 5);
    lines.push(`🌀 空洞调查: ${num} / ${total} 点${num >= total ? " (已达上限)" : ""}`);
  }

  // 补充其它官方字段
  const extraObj = { ...data };
  delete extraObj.energy;
  delete extraObj.vitality;
  delete extraObj.vhs_sale;
  delete extraObj.card_sign;
  delete extraObj.bounty_commission;
  delete extraObj.survey_points;

  const extraLines = dataLines(extraObj, { budget: { left: 15 } });
  if (extraLines.length) {
    lines.push(divider(), ...extraLines);
  }
  lines.push(divider(), command(ctx, "sign") + "  " + command(ctx, "energyReminder"));

  await ctx.event.reply(lines.join("\n"));
}
