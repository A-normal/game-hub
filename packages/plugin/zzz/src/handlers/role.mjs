import { command, requireRole, problem } from "../text.mjs";
import {storeFor} from "../storage.mjs";
export async function handleSelectRole(ctx) {
  if (!ctx.args[0]) { await ctx.event.reply("用法："+command(ctx,"selectRole",["<UID>"])+"\n"+command(ctx,"listRoles")); return; }
  if (!ctx.vault.setActiveRole(ctx.event.unifiedUserId,"zzz",ctx.args[0])) throw problem("没有归属于您的该角色。请查看「"+command(ctx,"listRoles")+"」。");
  const role = ctx.vault.getActiveRole(ctx.event.unifiedUserId,"zzz");
  await ctx.event.reply("【绝区零】已成功将主角色切换为：["+role.uid+"] "+role.nickname+" (Lv."+role.level+")\n"+command(ctx,"note"));
}
export async function handleListRoles(ctx) {
  const roles = ctx.vault.getUserRoles(ctx.event.unifiedUserId,"zzz");
  await ctx.event.reply("【绝区零角色列表】\n"+(roles.length ? roles.map(r=>r.nickname+" ["+r.uid+"] Lv."+r.level+(r.is_active ? " ★[当前主角色]" : "")).join("\n") : "尚未绑定角色。")+"\n"+command(ctx,roles.length ? "selectRole" : "loginQr",roles.length ? ["<UID>"] : []));
}
export async function handleAccount(ctx) {
  if (ctx.matchedToken === "解绑") {
    if (ctx.event.isGroup) { await ctx.event.reply("请私聊解绑账号。"); return {status:"DENIED"}; }
    const role = await requireRole(ctx); if (!role) return;
    const unboundUids=ctx.vault.getUserRoles(ctx.event.unifiedUserId,"zzz").filter(row=>row.provider_id===role.providerId && row.account_key===role.accountKey).map(row=>row.uid);
    const store=storeFor(ctx);for(const job of store.jobs(ctx.event.unifiedUserId))if(unboundUids.includes(job.uid))store.setJob({...job,enabled:false});
    ctx.vault.unbindUser(ctx.event.unifiedUserId,role.providerId,role.accountKey);
    await ctx.event.reply("已解除您与当前社区账号的绑定。"); return;
  }
  const role = await requireRole(ctx); if (!role) return;
  if (ctx.matchedToken === "删除设备") { ctx.vault.saveCredential(role.providerId,role.accountKey,role.cookies,{}); await ctx.event.reply("已删除当前账号的设备配置。"); return; }
  if (!ctx.args.length) { await ctx.event.reply("用法："+command(ctx,"device",["<device_id>","[device_fp]"])+"\n设备配置属于当前社区账号，共享该账号的绑定使用相同配置。"); return; }
  if (ctx.event.isGroup) { await ctx.event.reply("请在私聊配置设备。"); return {status:"DENIED"}; }
  if (ctx.args.some(v=>!/^[a-zA-Z0-9._-]{1,128}$/.test(v))) throw problem("设备标识格式无效。");
  ctx.vault.saveCredential(role.providerId,role.accountKey,role.cookies,{device_id:ctx.args[0],...(ctx.args[1] ? {device_fp:ctx.args[1]} : {})});
  await ctx.event.reply("设备配置已保存。");
}
