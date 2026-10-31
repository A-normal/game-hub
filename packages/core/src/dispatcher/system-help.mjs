const entry = (description, args = [], details = [], scope = "全局；仅系统管理员") => ({description, args, details, scope, group: "系统管理"});
export const SYSTEM_COMMAND_HELP = {
  help: entry("查看常用管理指令、完整清单或详细用法", ["[指令|全部 页码]"]),
  auth: entry("使用注册令牌登记为系统管理员", ["<注册令牌>"], ["注册令牌由部署维护者配置 GAMEHUB_ADMIN_REGISTRATION_TOKEN；渠道连接令牌不能用于注册。", "仅为发送指令的当前渠道用户授权；授权在重启后保留。", "请勿在群聊发送令牌；重复注册不会新增重复身份。"], "仅私聊；当前用户"),
  status: entry("查看运行时间、插件与驱动数量"),
  plugins: entry("查看插件启用情况及社区驱动"),
  enable: entry("启用指定业务插件", ["<插件ID>"]),
  disable: entry("禁用指定业务插件", ["<插件ID>"], ["系统管理插件不能禁用。"]),
  namespace: entry("设置插件前缀及独立调用别名", ["<插件ID>", "<前缀或空字符串>", "[逗号分隔的别名]"], ["前缀与别名各自独立使用，不拼接；省略别名时保留已有配置。", "用两个引号表示空字符串；别名填空字符串可清空别名。"]),
  admins: entry("查看系统管理员列表及授权来源"),
  addAdmin: entry("授予用户系统管理员权限", ["<平台:用户ID>"], ["必须提供完整平台身份，不接受裸用户ID、昵称或用户名。", "仅系统管理员可为其他身份授权；新用户可私聊使用注册令牌认证本人。"]),
  removeAdmin: entry("撤销用户系统管理员权限", ["<平台:用户ID>"], ["聊天注册的管理员撤销后立即失去权限。", "环境预置管理员需由维护者移出 GAMEHUB_ADMIN_USERS 并重新载入。", "仍持有有效注册令牌的人可以再次注册；移除授权与轮换令牌是独立操作。"]),
  log: entry("修改当前日志输出级别", ["<DEBUG|INFO|WARN|ERROR|SILENT>"])
};
const examples = {help:["认证"],auth:["<系统管理员注册令牌>"],enable:["zzz"],disable:["zzz"],namespace:["zzz","%","zzz,绝区零"],addAdmin:["mock:user"],removeAdmin:["mock:user"],log:["INFO"]};
for (const [id, value] of Object.entries(SYSTEM_COMMAND_HELP)) value.examples = [examples[id] || []];
