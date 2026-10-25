import { command, requireRole, problem } from "../text.mjs";
import { title, divider, kv } from "../layout.mjs";
import {storeFor} from "../storage.mjs";
import crypto from "node:crypto";
import { normalizeAndroidProfile } from "@game-hub/provider-mihoyo";
export async function handleSelectRole(ctx) {
  if (!ctx.args[0]) { await ctx.event.reply("用法："+command(ctx,"selectRole",["<UID>"])+"\n"+command(ctx,"listRoles")); return; }
  if (!ctx.vault.setActiveRole(ctx.event.unifiedUserId,"zzz",ctx.args[0])) throw problem("没有归属于您的该角色。请查看「"+command(ctx,"listRoles")+"」。");
  const role = ctx.vault.getActiveRole(ctx.event.unifiedUserId,"zzz");
  await ctx.event.reply([
    title("绝区零主角色已切换"),
    divider(),
    ...kv([["昵称", role.nickname], ["UID", role.uid], ["等级", role.level === undefined || role.level === null ? "" : "Lv." + role.level], ["区服", role.region]], { align: false }),
    divider(),
    command(ctx,"note")
  ].join("\n"));
}
export async function handleListRoles(ctx) {
  const roles = ctx.vault.getUserRoles(ctx.event.unifiedUserId,"zzz");
  const lines = [title("绝区零角色列表"), divider()];
  if (!roles.length) lines.push("尚未绑定角色。");
  else roles.forEach((r,index) => {
    lines.push((index + 1) + ". " + r.nickname + " [" + r.uid + "]" + (r.is_active ? " ★ 当前主角色" : ""));
    lines.push("   Lv." + (r.level ?? "未返回") + " · " + r.region);
  });
  lines.push(divider(), command(ctx,roles.length ? "selectRole" : "loginQr",roles.length ? ["<UID>"] : []));
  await ctx.event.reply(lines.join("\n"));
}
const maskDevice = value => !value ? "未设置" : String(value).length <= 6 ? "*".repeat(String(value).length) : String(value).slice(0,4) + "***";
const currentDevice = role => ({ ...(role.device || {}) });
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
  if (["帮助", "help"].includes(ctx.args[0])) {
    await ctx.event.reply([
      title("绝区零设备配置帮助"),
      "请使用您自己的常用米游社设备信息；字段对应官方客户端请求头 x-rpc-device_id 与 x-rpc-device_fp。",
      "只在私聊提交：" + command(ctx,"device",["<device_id>","[device_fp]"]),
      "Android 可导入设备工具导出的七字段 JSON：" + command(ctx,"device",["<设备JSON>"]),
      "设备工具源码及构建说明：https://github.com/forchannot/get_device_info",
      "查看状态：" + command(ctx,"device"),
      "设备信息与账号校验有关；随机指纹和反复扫码不能保证解决 10041。请先在官方客户端检查账号与安全验证状态。"
    ].join("\n"));
    return;
  }
  if (ctx.event.isGroup && (ctx.args.length || ctx.routeId==="deviceDefault" || ctx.matchedToken==="删除设备")) {
    await ctx.event.reply("请在私聊配置设备。"); return {status:"DENIED"};
  }
  const existing = currentDevice(role);
  // Network issuance may overlap a login or an unbind. Preserve newer cookies and
  // refuse to overwrite a concurrently changed device or recreate a removed binding.
  const saveIssued = issued => {
    const latest=ctx.vault.getUserCredential(ctx.event.unifiedUserId,role.providerId,role.accountKey);
    if(!latest || JSON.stringify(latest.device)!==JSON.stringify(existing))throw problem("账号绑定或设备配置已变化，请重新执行设备配置。");
    ctx.vault.saveCredential(role.providerId,role.accountKey,latest.cookies,{...latest.device,...issued});
  };
  if (ctx.matchedToken === "删除设备") {
    ctx.vault.saveCredential(role.providerId,role.accountKey,role.cookies,{});
    await ctx.event.reply(title("绝区零设备配置") + "\n已清空当前账号的设备配置。清空后每次请求都会以全新设备身份发出，容易触发米游社设备校验（10041）。");
    return;
  }
  if (ctx.routeId==="deviceDefault") {
    if(ctx.args.length && (ctx.args.length!==1 || ctx.args[0]!=="刷新指纹")) throw problem("用法："+command(ctx,"deviceDefault",["[刷新指纹]"]));
    // 只补缺失字段：已有真机指纹时绝不用随机值覆盖。
    const deviceId=existing.device_id || crypto.randomUUID();
    const replaceFp=ctx.matchedToken==="更新设备指纹" || ctx.args[0]==="刷新指纹" || !existing.device_fp;
    const issued=replaceFp ? await ctx.provider.issueDeviceFingerprint(deviceId,{region:role.region,mobile:existing.device_android}) : {};
    const dev = {
      ...existing,...issued,
      device_id: deviceId,
      device_name: issued.device_name || existing.device_name || "Game-Hub Standalone",
      device_model: issued.device_model || existing.device_model || "GH-2026"
    };
    saveIssued(dev);
    await ctx.event.reply([
      title("绝区零设备配置"),
      divider(),
      ...kv([["设备ID", dev.device_id], ["设备指纹", dev.device_fp], ["来源", replaceFp ? "官方设备接口签发" : "沿用已绑定设备"]], { align: false }),
      divider(),
      "此指纹由官方服务签发，但不等于手机常用设备的授权；仍报 10041 时可用「" + command(ctx,"device",["<device_id>","<device_fp>"]) + "」绑定自己常用客户端的信息。"
    ].join("\n"));
    return;
  }
  if (!ctx.args.length) {
    await ctx.event.reply([
      title("绝区零设备配置"),
      divider(),
      ...kv([["设备ID", maskDevice(existing.device_id)], ["设备指纹", maskDevice(existing.device_fp)]], { align: false }),
      divider(),
      "用法：" + command(ctx,"device",["<device_id>","[device_fp]"]),
      "Android 设备信息导入：" + command(ctx,"device",["<设备JSON>"]),
      "设备配置属于当前社区账号，共享该账号的绑定使用同一套配置；已有字段在未提供时保持不变。"
    ].join("\n"));
    return;
  }
  const raw=(ctx.argumentText ?? ctx.args.join(" ")).trim();
  if(raw.startsWith("{")) {
    if(raw.length>8192)throw problem("设备 JSON 超过长度限制。");
    let info;try{info=JSON.parse(raw);}catch{throw problem("设备 JSON 格式无效。");}
    if(info && typeof info==="object" && !Array.isArray(info) && typeof info.device_id==="string" && typeof info.device_fp==="string") {
      ctx.args=[info.device_id,info.device_fp];
    } else {
      let mobile;try{mobile=normalizeAndroidProfile(info);}catch(error){throw problem(error.message);}
      const issued=await ctx.provider.issueDeviceFingerprint(existing.device_id || crypto.randomUUID(),{region:role.region,mobile});
      saveIssued(issued);
      await ctx.event.reply([title("Android 设备配置已更新"),"官方已签发设备指纹；这不代表已通过账号设备授权。",...kv([["设备ID",maskDevice(issued.device_id)],["设备指纹",maskDevice(issued.device_fp)]],{align:false}),command(ctx,"note")].join("\n"));
      return;
    }
  }
  if (ctx.args.length > 2 || ctx.args.some(v=>!/^[a-zA-Z0-9._-]{1,128}$/.test(v))) throw problem("设备标识格式无效。用法：" + command(ctx,"device",["<device_id>","[device_fp]"]));
  // 合并而非替换：只改本次给出的字段，避免只补 device_id 时把已有指纹抹掉。
  const merged = { ...existing, device_id: ctx.args[0] };
  if (ctx.args[1]) {merged.device_fp = ctx.args[1];merged.device_fp_source="manual";delete merged.device_fp_issued_at;}
  ctx.vault.saveCredential(role.providerId,role.accountKey,role.cookies,merged);
  const notes = [];
  if (!ctx.args[1]) notes.push(existing.device_fp ? "未提供指纹，沿用原值：" + maskDevice(existing.device_fp) : "未提供指纹：当前仍未设置。");
  if (merged.device_fp && !/^[0-9a-f]{13}$/i.test(merged.device_fp)) notes.push("提示：官方 App 的 x-rpc-device_fp 通常是 13 位十六进制。");
  await ctx.event.reply([
    title("绝区零设备配置已更新"),
    divider(),
    ...kv([["设备ID", merged.device_id], ["设备指纹", merged.device_fp || "未设置"]], { align: false }),
    ...(notes.length ? [divider(), ...notes] : []),
    divider(),
    command(ctx, "note")
  ].join("\n"));
}
