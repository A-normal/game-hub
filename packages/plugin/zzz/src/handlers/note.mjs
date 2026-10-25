import { requireRole, dataLines } from "../text.mjs";
export async function handleNote(ctx) {
  const role = await requireRole(ctx,"绝区零便签"); if (!role) return;
  const data = await ctx.client.getDailyNote(role.uid,role.region);
  const lines = ["【绝区零便签】","绳匠: "+role.nickname+" (UID: "+role.uid+")","来源：米游社实时便签"];
  if (data.energy) {
    const e = data.energy.progress || data.energy;
    if (e.current !== undefined && e.max !== undefined) lines.push("实时电量: "+e.current+" / "+e.max+(Number(e.current)>=Number(e.max)?" (已回满)":""));
    if (data.energy.restore !== undefined || data.energy.restore_time !== undefined) lines.push("恢复时间（秒）: "+(data.energy.restore ?? data.energy.restore_time));
  }
  const vitality=data.vitality?.progress || data.vitality;
  if (vitality?.current!==undefined && vitality.max!==undefined) lines.push("每日活跃: "+vitality.current+" / "+vitality.max);
  lines.push(...dataLines(data));
  await ctx.event.reply(lines.join("\n"));
}
