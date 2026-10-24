/**
 * @file packages/core/src/types.mjs
 * @description Game-Hub 核心实体与接口契约
 */

/**
 * 渠道发送结果
 * @typedef {Object} IDeliveryResult
 * @property {boolean} success - 是否发送成功
 * @property {string} [messageId] - 发送成功后的消息ID
 * @property {string} [error] - 错误信息
 */

/**
 * 规范化入站事件包 (EventEnvelope)
 * @typedef {Object} IEventEnvelope
 * @property {string} eventId - 事件唯一ID (用于去重)
 * @property {string} messageId - 平台原生消息ID
 * @property {string} platform - 平台标识 (如 "qq-napcat", "telegram")
 * @property {string} unifiedUserId - 规范化用户主键 (如 "qq:123456", "tg:987654321")
 * @property {string} rawText - 原始消息文本
 * @property {string} cleanText - 预处理剥离 @Bot 后的干净指令文本
 * @property {boolean} isGroup - 是否为群聊消息
 * @property {string} [groupId] - 群组ID
 * @property {number} timestamp - 消息时间戳 (秒)
 * @property {{ id: string, name: string, role?: string }} sender - 发送者信息
 * @property {(content: string | Object, options?: Object) => Promise<IDeliveryResult>} reply - 回复函数
 */

/**
 * 用户当前选中的游戏角色
 * @typedef {Object} SelectedRole
 * @property {string} uid - 游戏内角色 UID
 * @property {string} region - 区服标识 (如 "prod_gf_cn", "prod_gf_us")
 * @property {string} nickname - 角色昵称
 * @property {number} level - 角色等级
 * @property {string} providerId - 社区提供商标识 (如 "mihoyo")
 * @property {string} accountKey - 社区账号唯一标识 (如米游社 ltuid)
 * @property {Record<string, string>} cookies - 账号凭据键值对
 * @property {{ device_id?: string, device_fp?: string }} device - 设备指纹元数据
 */

/**
 * 注入业务插件的执行上下文
 * @typedef {Object} IGameContext
 * @property {IEventEnvelope} event - 入站事件
 * @property {string} gameId - 目标游戏标识 (如 "zzz")
 * @property {string} matchedToken - 命中的纯语义词元 (如 "便签", "绑定")
 * @property {string[]} args - 指令参数列表
 * @property {SelectedRole | null} activeRole - 当前用户激活的默认角色 (未绑定时为 null)
 * @property {any} client - 注入的底层社区受保护请求客户端
 * @property {any} vault - 身份保密库实例
 */

/**
 * 纯游戏插件路由项
 * @typedef {Object} IGameRoute
 * @property {string} id - 路由唯一标识
 * @property {string[]} tokens - 纯指令词元清单 (严禁带任何正则符号)
 * @property {(ctx: IGameContext) => Promise<boolean | 'return' | void>} action - 业务处理函数
 * @property {string} [description] - 功能描述
 */

/**
 * 纯游戏插件元数据定义
 * @typedef {Object} IGamePluginManifest
 * @property {string} gameId - 游戏全局唯一标识 (如 "zzz")
 * @property {string} name - 游戏展示名 (如 "绝区零")
 * @property {string} community - 所依赖的社区驱动 SPI (如 "mihoyo")
 * @property {IGameRoute[]} routes - 纯指令路由清单
 */

export const Platforms = {
  NAPCAT: "qq-napcat",
  TELEGRAM: "telegram",
  QQBOT: "qqbot",
  MOCK: "mock"
};
