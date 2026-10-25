import { handleBind } from "./handlers/bind.mjs";
import { handleLoginQr } from "./handlers/login-qr.mjs";
import { handleSelectRole,handleListRoles,handleAccount } from "./handlers/role.mjs";
import { handleNote } from "./handlers/note.mjs";
import { handlePanel } from "./handlers/panel.mjs";
import { handleRecord,handleMonthly,handlePools } from "./handlers/records.mjs";
import { handleSign } from "./handlers/sign.mjs";
import { handleGacha } from "./handlers/gacha.mjs";
import { handleHelp } from "./handlers/help.mjs";
import { handleAlias,handleTasks,handleRanking,handleCalculationSettings,handleMaintenance } from "./handlers/settings.mjs";
import { handleContent } from "./handlers/content.mjs";
const route=(id,tokens,description,action,extra={})=>({id,tokens,description,action:async ctx=>{
  try {return await action(ctx);} catch(error) {
    if(error?.retcode===10041) error.publicMessage = (error.publicMessage || "米游社设备或安全校验未通过（10041）。") + "\n扫码登录与常用设备绑定均保留。Android 用户可在私聊使用「"+ctx.commands.format({routeId:"device",args:["<设备JSON>"]})+"」绑定常用手机信息；已有设备信息会在正常重新扫码时保留，请勿反复重建设备。这些操作不能保证解除所有官方校验。";
    throw error;
  }
},...extra});
export const ZZZPluginManifest={
  id:"zzz",kind:"plugin",contractVersion:1,gameId:"zzz",name:"绝区零",
  defaultNamespace:{prefix:"*",aliases:["zzz","绝区零"],priority:100},
  providers:[{id:"mihoyo",capabilities:["game-record","account","sign","gacha"]}],
  routes:[
    route("help",["帮助","help","菜单"],"查看纯文本命令",handleHelp),
    route("loginQr",["扫码登录","扫码绑定","扫码","二维码登录","二维码绑定","二维码"],"米游社扫码登录 [web] [重建设备]",handleLoginQr),
    route("loginCancel",["扫码终止","取消扫码"],"取消当前登录",handleLoginQr),
    route("bind",["绑定","添加账号","绑定国际服"],"私聊手动绑定 Cookie；无参数扫码",handleBind),
    route("unbind",["解绑"],"私聊解除当前社区账号绑定",handleAccount),
    route("selectRole",["选角色","切换角色","设置角色"],"选择主角色 <UID>",handleSelectRole),
    route("listRoles",["角色列表","我的角色","角色清单"],"列出绑定的角色",handleListRoles),
    route("device",["绑定设备","设备配置","删除设备"],"私聊设置设备 ID [指纹] 或 Android 设备 JSON",handleAccount),
    route("deviceDefault",["默认设备","重置设备","更新设备指纹"],"补全官方签发的设备指纹 [刷新指纹]",handleAccount),
    route("aliases",["设置别名","角色别名","删除别名"],"设置个人角色别名 [别名 完整名称/ID]",handleAlias),
    route("cooldown",["面板冷却","刷新冷却"],"查询或设置个人面板刷新冷却时间 [秒数]",handleMaintenance),
    route("cacheClean",["清理缓存","清除缓存","刷新资源"],"清理本地指定业务或全部缓存 [面板|卡池|全部]",handleMaintenance),
    route("note",["便签","体力","电量"],"查询实时便签",handleNote),
    route("card",["资料","绳网资料","名片"],"查询绳网资料",handleRecord),
    route("avatars",["代理人","角色图鉴"],"查询代理人列表 [页码]",handleRecord),
    route("buddies",["邦布","邦布列表"],"查询邦布列表 [页码]",handleRecord),
    route("panelRefresh",["更新面板","刷新面板"],"官方全角色更新 [角色名/ID]",handlePanel),
    route("showcaseRefresh",["更新展柜面板","刷新展柜","更新展柜"],"公开展柜更新 [UID] [角色]",handlePanel),
    route("panelList",["面板列表","展柜列表"],"查看缓存面板列表",handlePanel),
    route("showcase",["展柜"],"公开展柜查询 [UID] [角色]",handlePanel),
    route("panel",["面板"],"查询面板 [UID] [角色名/ID]",handlePanel,{suffixTokens:["面板"]}),
    route("proficiency",["练度","练度统计"],"按已验证规则统计属性达成",handlePanel),
    route("score",["评分"],"查看角色评分 [角色名/ID]",handlePanel),
    route("weights",["评分权重"],"查看当前角色评分规则 [角色]",handlePanel),
    route("mainstats",["主词条收益"],"比较角色驱动盘主词条 <角色> [4|5|6]",handlePanel),
    route("conditions",["计算条件"],"查看角色专属增益条件 <角色>",handlePanel),
    route("damage",["伤害"],"查看独立规则的场景估算 [角色]",handlePanel),
    route("calculationSettings",["计算设置"],"查询或设置个人计算场景 JSON",handleCalculationSettings),
    ...[
      ["abyss",["式舆防卫战","深渊","防卫战","剧变节点"],"式舆防卫战"],
      ["deadly",["危局强袭战","危局"],"危局强袭战"],
      ["holo",["全息拟境","拟境"],"全息拟境"],
      ["tower",["鏖战试炼","爬塔","模拟鏖战试炼"],"模拟鏖战试炼"],
      ["void",["临界推演","临界","临界总览"],"临界推演"],
      ["hollow",["零号空洞","空洞"],"零号空洞"],
      ["hollowDetail",["枯萎之都"],"空洞挑战"],
      ["hollow2",["迷失之地","零号空洞二期"],"迷失之地"],
      ["zenkov",["绝境作战"],"绝境作战"],
      ["zenkovDetail",["绝境详情"],"绝境作战详情"],
      ["exploration",["探索"],"探索进度"],
      ["calendar",["日历","活动日历"],"活动日历"]
    ].map(([id,tokens,name])=>route(id,tokens,name+" [上期/页码]",handleRecord)),
    route("monthly",["月报","收入","菲林"],"单月月报 [YYYY-MM]",handleMonthly),
    route("monthlySummary",["月报汇总","月报统计"],"已缓存月报汇总",handleMonthly),
    route("monthlyRefresh",["更新月报"],"同步可用月报并汇总已存档历史",handleMonthly),
    route("pools",["当前卡池","卡池","卡池历史","版本卡池","复刻统计"],"卡池快照、筛选和复刻统计 [关键字] [页码]",handlePools),
    route("poolsRefresh",["更新卡池","刷新卡池"],"刷新官方卡池安排",handlePools),
    route("gachaUpdate",["更新抽卡","更新调频","刷新抽卡","记录链接"],"自动更新调频 [私聊官方链接]",handleGacha),
    route("gachaRecords",["抽卡记录","调频记录"],"分池查看出金和垫抽 [明细 页码]",handleGacha),
    route("gachaAnalysis",["抽卡分析"],"调频统计分析",handleGacha),
    route("gachaImport",["导入抽卡"],"聊天内不导入；请在服务器执行导入工具",handleGacha),
    route("gachaExport",["导出抽卡"],"私聊导出 UIGF JSON",handleGacha),
    route("gachaLink",[],"私聊官方调频链接",handleGacha,{stage:"text",match:event=>/^https:\/\/\S*[?&](?:authkey|authkey_ver)=/i.test(event.cleanText || "")}),
    route("sign",["签到","每日签到","打卡"],"手动签到",handleSign),
    route("signStatus",["签到状态"],"查询签到状态",handleSign),
    route("autoSign",["自动签到"],"配置自动签到 <开启|关闭>",handleTasks),
    route("energyReminder",["电量提醒","体力提醒"],"配置电量提醒 <开启|关闭> [阈值]",handleTasks),
    route("challengeReminder",["挑战提醒"],"配置挑战截止提醒 <开启|关闭> [小时] [危局]",handleTasks),
    route("tasks",["任务状态","提醒状态"],"查询和管理已配置任务",handleTasks),
    route("rankGroup",["群排名设置"],"群管理员配置 <开启|关闭>",handleRanking),
    route("rankPublish",["提交排名"],"授权在当前群展示缓存战绩 [危局]",handleRanking),
    route("rankWithdraw",["撤回排名"],"撤回当前群授权",handleRanking),
    route("rankPrivacy",["排名隐私"],"隐藏全部或恢复 <隐藏|公开>",handleRanking),
    route("rankReset",["重置排名"],"群管理员清空当前群排名",handleRanking),
    route("rank",["排名","群排名"],"查询当前群授权榜单 [危局]",handleRanking),
    route("guide",["攻略"],"查询文字攻略或真实来源链接 [角色]",handleContent),
    route("skills",["技能","影画","图鉴"],"查询官方角色文字资料 <角色名/ID>",handleContent),
    route("codes",["兑换码"],"查看有来源及有效期的兑换码",handleContent)
  ]
};
export default ZZZPluginManifest;
