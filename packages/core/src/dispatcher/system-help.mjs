const entry = (description, args = [], details = [], scope = "全局；仅系统管理员") => ({description, args, details, scope, group: "系统管理"});
export const SYSTEM_COMMAND_HELP = {
  help: entry("查看常用管理指令、完整清单或详细用法", ["[指令|全部 页码]"]),
  auth: entry("使用令牌认证为系统管理员", ["<Token>"], ["请勿在群聊发送令牌。"], "仅私聊；当前用户"),
  status: entry("查看运行时间、插件与驱动数量"),
  plugins: entry("查看插件启用情况及社区驱动"),
  enable: entry("启用指定业务插件", ["<插件ID>"]),
  disable: entry("禁用指定业务插件", ["<插件ID>"], ["系统管理插件不能禁用。"]),
  namespace: entry("设置插件前缀及独立调用别名", ["<插件ID>", "<前缀或空字符串>", "[逗号分隔的别名]"], ["前缀与别名各自独立使用，不拼接；省略别名时保留已有配置。", "用两个引号表示空字符串；别名填空字符串可清空别名。"]),
  admins: entry("查看系统管理员列表"),
  addAdmin: entry("授予用户系统管理员权限", ["<统一用户ID>"]),
  removeAdmin: entry("撤销用户系统管理员权限", ["<统一用户ID>"]),
  log: entry("修改当前日志输出级别", ["<DEBUG|INFO|WARN|ERROR|SILENT>"])
};
const examples = {help:["认证"],auth:["<管理员令牌>"],enable:["zzz"],disable:["zzz"],namespace:["zzz","%","zzz,绝区零"],addAdmin:["mock:user"],removeAdmin:["mock:user"],log:["INFO"]};
for (const [id, value] of Object.entries(SYSTEM_COMMAND_HELP)) value.examples = [examples[id] || []];
