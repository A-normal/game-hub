/**
 * Shared module contracts. Module IDs and namespaces are separate.
 * @typedef {{success:boolean,messageId?:string,messageIds?:string[],partial?:boolean,partsDelivered?:number,error?:string}} IDeliveryResult
 * @typedef {Object} IEventEnvelope
 * @property {'message'|'notice'} [eventType]
 * @property {string} [noticeType]
 * @property {string} [noticeSubtype]
 * @property {string} [targetUserId]
 * @property {string} [recalledMessageId] Platform message ID referenced by a recall notice.
 * @property {Array<{id:string,name:string,size?:number,type:'file'|'image',readBytes?:(limits:{maxBytes:number})=>Promise<Buffer>}>} [attachments] Lazy, bounded channel-owned reads; no bridge-local paths.
 * @property {string[]} [channelCapabilities]
 * @property {string} eventId
 * @property {string} messageId
 * @property {string} platform
 * @property {string} unifiedUserId
 * @property {string} rawText
 * @property {string} cleanText
 * @property {boolean} isGroup
 * @property {string} [groupId]
 * @property {string} [botId]
 * @property {boolean} [commandHint]
 * @property {number} timestamp
 * @property {{id:string,name?:string,role?:string}} sender
 * @property {Array<{url?:string,file?:string}>} [images]
 * @property {{id:string,text?:string,images?:Array<{url?:string,file?:string}>}} [replyMessage]
 * @property {Array<{id:string}>} mentions 本条消息中的 @ 目标；`all` 原样保留，没有 at 段时为空数组
 * @property {boolean} mentionedBot 是否 @ 了当前机器人（mentions 中命中 self_id），无 at 段时为 false
 * @property {(content:string|Object,options?:Object)=>Promise<IDeliveryResult>} reply
 */
/**
 * @typedef {Object} SelectedRole
 * @property {string} uid
 * @property {string} region
 * @property {string} nickname
 * @property {number} level
 * @property {string} providerId
 * @property {string} accountKey
 * @property {Record<string,string>} cookies
 * @property {{device_id?:string,device_fp?:string}} device
 */
/**
 * @typedef {{pluginId?:string,routeId:string,args?:Array<string|number>}} CommandSpec
 * @typedef {{id:string,capabilities?:string[],optional?:boolean}} ProviderDependency
 * @typedef {{prefix:string,aliases:string[],priority?:number}} Namespace 前缀与别名等价，各自都是独立的调用标记
 * @typedef {{status:'NOT_MATCHED'|'HANDLED'|'FAILED'|'DENIED'}} RouteResult
 * @typedef {Object} IGameContext
 * @property {IEventEnvelope} event
 * @property {string} pluginId
 * @property {string} [gameId]
 * @property {string} routeId
 * @property {string} matchedToken
 * @property {string[]} args
 * @property {string} argumentText Original argument text with internal whitespace preserved.
 * @property {SelectedRole|null} activeRole Lazily resolved only for game plugins.
 * @property {Object} client Lazily created from the caller's binding.
 * @property {Object} provider
 * @property {{get:(id:string)=>Object}} providers
 * @property {{format:(command:CommandSpec)=>string}} commands Evaluates current namespace at each call.
 * @property {Object} config
 * @property {Object} services Plugin-owned dependencies, caches and tasks.
 * @property {Object} vault
 * @property {Object} dispatcher
 */
/**
 * @typedef {Object} IGameRoute
 * @property {string} id Stable route ID.
 * @property {string[]} [tokens] Semantic command tokens without namespace.
 * @property {string[]} [suffixTokens] Dynamic leading arguments, such as a character name.
 * @property {'command'|'text'|'observer'|'fallback'|'event'|'observer'} [stage] `observer` 在 text 之后、fallback 之前执行，返回值被忽略，route.admin 不参与鉴权
 * @property {boolean} [exact]
 * @property {boolean} [admin]
 * @property {string} [provider] Selected provider ID for this route.
 * @property {(event:IEventEnvelope)=>boolean} [match] Text/fallback/observer eligibility predicate.
 * @property {(ctx:IGameContext)=>Promise<RouteResult|boolean|void>|RouteResult|boolean|void} action
 * @property {string} [description]
 */
/**
 * @typedef {Object} IGamePluginManifest
 * @property {string} id
 * @property {'plugin'} kind
 * @property {1} contractVersion
 * @property {string} name
 * @property {string} [gameId]
 * @property {ProviderDependency[]} [providers]
 * @property {Namespace} defaultNamespace
 * @property {IGameRoute[]} routes
 * @property {Object} [services]
 * @property {()=>Promise<void>} [start] Called only by the explicit application lifecycle.
 * @property {()=>Promise<void>} [stop]
 */
/**
 * A module exports configSchema (supported JSON Schema subset) and
 * createModule({config,dispatcher,vault}); imports have no startup effects.
 * Provider instances expose id/kind/contractVersion/capabilities and typed services.
 * Channel instances expose id/kind/contractVersion/platforms/start/stop/send.
 */
export const Platforms = {NAPCAT:"qq-napcat",TELEGRAM:"telegram",QQBOT:"qqbot",MOCK:"mock"};
