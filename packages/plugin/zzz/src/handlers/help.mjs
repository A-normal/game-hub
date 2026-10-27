
export async function handleHelp(ctx) {
  return ctx.commands.help({
    title: "绝区零命令手册",
    common: ["bind", "device", "note", "listRoles", "selectRole", "panelRefresh", "panel", "gachaUpdate", "gachaRecords", "sign"],
    note: "账号认证与设备信息分别绑定；正常重新扫码保留已有设备。"
  });
}
