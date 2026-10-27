const entry = (description, args = [], scope = "当前会话；需 AI 管理权限", details = [], related = []) => ({description, args, scope, details, related});
const global = "全局配置；需 AI 管理权限";
const privateGlobal = "仅私聊；全局配置；需 AI 管理权限";
export const CHAT_COMMAND_HELP = {
  help: entry("查看常用指令、完整清单或指定指令用法", ["[指令|全部 页码]"]),
  settings: entry("查看当前配置与常用操作入口"),
  status: entry("查看运行情况、额度与最近生成结果", [], "当前会话；需 AI 管理权限", ["模型列表接口检查通过，不代表聊天生成已经验证。"], ["settings", "modelCheck"]),
  say: entry("明确发起一次聊天回复", ["<内容>"]),
  modelAdd: entry("向已有服务连接添加模型", ["[连接名称或ID]"], privateGlobal, ["先添加服务连接，再填写上游模型 ID 和显示名称；仅有一个连接时可省略参数。", "回复确认仅保存；确认并使用同时切换当前会话模型。"], ["connectionAdd", "connectionDiscover", "modelUse"]),
  modelSet: entry("修改模型的上游模型 ID", ["<模型名称或ID>"], privateGlobal, ["仅修改模型 ID；服务地址和密钥引用通过连接修改维护。", "共享连接的其他模型不受影响。"], ["connectionEdit", "modelOptions", "modelRename"]),
  modelRemove: entry("删除模型并解除相关会话的指定选择", ["<模型ID>"], global, ["相关会话改为跟随默认；删除默认模型后需重新设置默认。"]),
  modelList: entry("列出模型，私聊回复编号切换当前会话", ["[页码]"], global),
  modelCheck: entry("检查模型密钥配置与模型列表接口", ["[模型ID]"], global, ["不发送聊天生成请求；检查通过不代表生成可用。"]),
  connectionAdd: entry("新增服务地址与密钥引用", [], privateGlobal, ["密钥值由维护者放入环境；这里只接收环境变量名。"]),
  connectionList: entry("列出服务连接，私聊回复编号看详情", [], global),
  connectionInfo: entry("查看服务地址及其关联模型", ["<连接名称或ID>"], global),
  connectionEdit: entry("修改服务地址与密钥引用", ["<连接名称或ID>"], privateGlobal, ["修改影响该连接下的全部模型，并使相关旧请求失效。"], ["modelSet"]),
  connectionDelete: entry("删除没有关联模型的服务连接", ["<连接名称或ID>"], global, ["有关联模型时拒绝删除；请先处理关联模型。"]),
  connectionDiscover: entry("读取服务支持的模型，回复编号添加", ["[连接名称或ID]", "[页码]"], privateGlobal, ["需要服务支持标准模型列表接口；不支持时可手动添加。"], ["modelAdd"]),
  modelUse: entry("仅为当前会话切换模型", ["<模型名称或ID|跟随默认>"], "当前会话；需 AI 管理权限", ["不会改变其他会话，也不会更改全局默认模型。"], ["defaultModel"]),
  defaultModel: entry("设置跟随默认的会话使用的全局模型", ["[模型名称或ID]"], global, ["不带参数列出可选模型；已有显式选择的会话保持原选择。"], ["modelUse"]),
  modelInfo: entry("查看模型参数、所属连接和生成结果", ["[模型名称或ID]"], global),
  modelRename: entry("修改模型显示名称", ["<模型名称或ID>", "<显示名称>"], global),
  modelOptions: entry("设置温度、输出、超时或上下文预算", ["<模型名称或ID>", "<温度|输出|超时|上下文>", "<值>"], global, ["温度0–2；输出1–4096；超时1000–120000毫秒；上下文2000–80000字符。"]),
  characterList: entry("列出人物卡，私聊回复编号切换", [], global),
  characterImport: entry("新增人物卡；同名卡不会被覆盖", ["[文本或JSON]"], privateGlobal, ["不带参数后单独发送 TXT、Markdown 或 JSON 文件，10分钟内有效，最多1 MiB。", "导入后不会自动启用。"], ["characterUse", "characterOverwrite"]),
  characterUse: entry("切换当前会话使用的人物", ["<人物ID>"]),
  characterOff: entry("卸下当前会话人物，使用通用助手"),
  characterPreview: entry("分页预览人物卡内容", ["<人物ID>", "[页码]"], global),
  characterEdit: entry("修改人物卡的单个字段", ["<人物ID>"], privateGlobal, ["按向导选择字段、填写内容并确认；不是整卡替换。"], ["characterOverwrite"]),
  characterOverwrite: entry("用整张人物卡替换已有内容", ["<人物ID>", "[文本或JSON]"], privateGlobal, ["保留人物 ID 和会话绑定；不带内容时单独发送新卡文件。"], ["characterEdit"]),
  characterExport: entry("以 JSON 文件导出完整人物卡", ["<人物ID>"], privateGlobal),
  characterDelete: entry("删除人物并清除其对话分支", ["<人物ID>", "[确认]"], global, ["先显示影响范围；附加确认后执行删除并解除会话绑定。"]),
  policySet: entry("设置关闭、仅被@或始终回复", ["<off|mention|all>"], "当前会话；需 AI 管理权限", ["off关闭记录和回复；mention仅被@时回复；all处理普通文本。私聊只接受off或all。"]),
  contextShow: entry("查看当前人物分支的对话上下文状态"),
  contextClear: entry("清空当前人物分支的对话与摘要", [], "当前会话当前人物分支；需 AI 管理权限", ["取消依赖旧上下文的回复；显式长期记忆保留。"], ["memoryList", "summaryClear"]),
  aiAuth: entry("使用令牌认证为 AI 管理员", ["<token>"], "仅私聊；当前用户", ["系统管理员默认拥有 AI 管理权限；请勿在群聊发送令牌。"]),
  aiAdminList: entry("列出 AI 管理员", [], global),
  aiAdminRemove: entry("撤销用户的 AI 管理员身份", ["<统一用户ID>"], "仅系统管理员；全局配置", ["不会撤销该用户已有的系统管理员身份。"]),
  retry: entry("重新生成当前分支最近问题的回答"),
  cancel: entry("取消当前会话正在生成或排队的回复"),
  memorySet: entry("开启或关闭显式长期记忆注入", ["<on|off>"], "当前会话；需 AI 管理权限", ["关闭后已保存记忆仍保留，可查看或删除。"]),
  memoryAdd: entry("保存一条显式长期记忆", ["<内容>"], "当前会话；需 AI 管理权限", ["每条最多500字符，每会话最多40条；不会自动开启记忆注入。"]),
  memoryList: entry("查看本会话保存的显式长期记忆"),
  memoryDelete: entry("删除本会话的一条长期记忆", ["<编号>"]),
  summarize: entry("调用模型总结并保存当前分支对话", [], "当前会话当前人物分支；需 AI 管理权限", ["消耗一次模型调用额度，原始对话记录保留。"]),
  summaryClear: entry("删除当前分支摘要，保留原始对话", [], "当前会话当前人物分支；需 AI 管理权限"),
  eventSet: {...entry("配置戳一戳、入群等事件回复", ["<on|off>"], "当前会话；需 AI 管理权限", ["整体开启使用固定模板；persona模式会调用模型并消耗额度。", "事件类型：poke戳一戳、join入群、leave离群、recall撤回。"]), usages: [["<on|off>"], ["<poke|join|leave|recall>", "<off|template|persona>", "[模板]"]]},
  stickerAdd: entry("登记表情并上传图片", ["<短ID>", "<名称>"], "仅私聊；全局素材库；需 AI 管理权限", ["指令后单独上传 PNG/JPEG/GIF/WebP 图片，最多4 MiB。"]),
  stickerList: entry("列出已登记表情素材", ["[页码]"], global),
  stickerPreview: entry("预览已登记的表情图片", ["<ID>"], global),
  stickerReplace: entry("上传图片替换已有表情素材", ["<ID>"], privateGlobal),
  stickerTags: entry("设置表情标签与所属人物素材集", ["<ID>", "<标签,标签>", "<人物ID或*>"], global, ["人物填*表示通用；标签填-表示清空。"]),
  stickerImport: entry("批量导入表情素材包", [], privateGlobal, ["指令后发送JSON素材包；最多100项、4 MiB，整包校验失败则不保存。"]),
  stickerDelete: entry("删除指定表情素材", ["<ID>"], global),
  stickerSet: entry("开启或关闭当前会话的表情回复", ["<on|off>"]),
  proactiveSet: entry("设置空闲问候间隔，0表示关闭", ["<5–1440分钟|0>"], "当前会话；需 AI 管理权限", ["Asia/Shanghai 23:00–08:00保持安静；问候生成计入模型额度。"]),
  proactiveStatus: entry("查看当前会话的空闲问候配置")
};

for (const [id, value] of Object.entries(CHAT_COMMAND_HELP)) {
  value.group = /^(connection|model|defaultModel)/.test(id) ? "服务与模型"
    : id.startsWith("character") ? "人物卡"
    : /^(memory|summarize|summary)/.test(id) ? "记忆与摘要"
    : /^(sticker|event|proactive)/.test(id) ? "可选行为"
    : id.startsWith("ai") ? "管理员" : "会话与帮助";
}

const examples = {
  help: ["模型切换"], say: ["你好"], modelAdd: ["主服务"], modelSet: ["日常聊天"],
  modelRemove: ["model-main"], connectionInfo: ["主服务"], connectionEdit: ["主服务"],
  connectionDelete: ["主服务"], connectionDiscover: ["主服务"], modelUse: ["日常聊天"],
  defaultModel: ["日常聊天"], modelRename: ["model-main", "日常聊天"],
  modelOptions: ["日常聊天", "温度", "0.7"], characterUse: ["character-main"],
  characterPreview: ["character-main"], characterEdit: ["character-main"],
  characterOverwrite: ["character-main"], characterExport: ["character-main"],
  characterDelete: ["character-main"], policySet: ["all"], aiAuth: ["<管理员令牌>"],
  aiAdminRemove: ["mock:user"], memorySet: ["on"], memoryAdd: ["请使用中文回复"],
  memoryDelete: ["1"], eventSet: ["join", "template", "欢迎加入"],
  stickerAdd: ["happy", "开心"], stickerPreview: ["happy"], stickerReplace: ["happy"],
  stickerTags: ["happy", "开心,微笑", "*"], stickerDelete: ["happy"], stickerSet: ["on"],
  proactiveSet: ["30"]
};
for (const [id, value] of Object.entries(CHAT_COMMAND_HELP)) value.examples = [examples[id] || []];
