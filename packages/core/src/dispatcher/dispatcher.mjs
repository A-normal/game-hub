/**
 * @file packages/core/src/dispatcher/dispatcher.mjs
 * @description 动态命名空间微内核调度器：剥离前缀与别名，提取纯词元，装配上下文并注入执行
 */

export class GameHubDispatcher {
  /**
   * @param {Object} [options]
   * @param {import('../identity/vault.mjs').IdentityVault} [options.vault] - 身份保密库
   */
  constructor(options = {}) {
    this.vault = options.vault || null;
    /** @type {Map<string, import('../types.mjs').IGamePluginManifest>} */
    this.plugins = new Map();
    /** @type {Map<string, any>} */
    this.providers = new Map();
    /** @type {Map<string, { prefix: string, aliases: string[], priority: number }>} */
    this.namespaces = new Map();

    // 默认提供绝区零配置
    this.namespaces.set("zzz", {
      prefix: "*",
      aliases: ["zzz", "ZZZ", "绝区零"],
      priority: 100
    });
  }

  /**
   * 注册社区驱动 (SPI)
   */
  registerProvider(provider) {
    if (!provider || !provider.id) throw new Error("Invalid provider: missing id");
    this.providers.set(provider.id, provider);
  }

  /**
   * 注册纯游戏业务插件
   * @param {import('../types.mjs').IGamePluginManifest} plugin
   */
  registerPlugin(plugin) {
    if (!plugin || !plugin.gameId) throw new Error("Invalid plugin: missing gameId");
    this.plugins.set(plugin.gameId, plugin);
  }

  /**
   * 加载部署人员命名空间配置 (如来自 namespaces.yaml)
   * @param {Record<string, { prefix?: string, aliases?: string[], priority?: number }>} config
   */
  loadNamespaceConfig(config) {
    if (!config || typeof config !== "object") return;
    for (const [gameId, cfg] of Object.entries(config)) {
      this.namespaces.set(gameId, {
        prefix: cfg.prefix !== undefined ? String(cfg.prefix) : "*",
        aliases: Array.isArray(cfg.aliases) ? cfg.aliases.map(String) : [],
        priority: Number(cfg.priority || 50)
      });
    }
  }

  /**
   * 解析入站消息是否属于某个命名空间与游戏
   * @param {string} cleanText
   * @returns {{ gameId: string, commandText: string } | null}
   */
  resolveNamespace(cleanText) {
    if (!cleanText) return null;

    // 按优先级从高到低排序命名空间
    const sortedNamespaces = Array.from(this.namespaces.entries()).sort(
      (a, b) => b[1].priority - a[1].priority
    );

    for (const [gameId, ns] of sortedNamespaces) {
      let text = cleanText.trim();
      let matchedPrefix = false;

      // 1. 匹配并剥离部署人员前缀 (如 "*")
      if (ns.prefix && text.startsWith(ns.prefix)) {
        text = text.slice(ns.prefix.length).trim();
        matchedPrefix = true;
      }

      // 2. 匹配并剥离游戏别名 (如 "zzz" 或 "绝区零")
      let matchedAlias = false;
      for (const alias of ns.aliases) {
        if (text.toLowerCase().startsWith(alias.toLowerCase())) {
          text = text.slice(alias.length).trim();
          matchedAlias = true;
          break;
        }
      }

      // 规则：只要命中了前缀，或者命中了别名，即可判定归属于该游戏
      if (matchedPrefix || matchedAlias) {
        return { gameId, commandText: text };
      }
    }

    return null;
  }

  /**
   * 核心调度逻辑
   * @param {import('../types.mjs').IEventEnvelope} event
   * @returns {Promise<boolean | 'return'>}
   */
  async dispatch(event) {
    const resolved = this.resolveNamespace(event.cleanText);
    if (!resolved) {
      return false; // 未匹配任何游戏命名空间，安全放行给后续普通对话
    }

    const { gameId, commandText } = resolved;
    const plugin = this.plugins.get(gameId);
    if (!plugin) {
      return false;
    }

    // 在插件的路由表中进行最长词元匹配 (Longest Token Matching)
    let bestRoute = null;
    let matchedToken = "";
    let argsText = "";

    for (const route of plugin.routes) {
      for (const token of route.tokens) {
        if (commandText.startsWith(token) && token.length > matchedToken.length) {
          bestRoute = route;
          matchedToken = token;
          argsText = commandText.slice(token.length).trim();
        }
      }
    }

    if (!bestRoute) {
      return false; // 命中了游戏命名空间但未命中具体指令词元，放行
    }

    // 提取参数列表 (空格分隔)
    const args = argsText ? argsText.split(/\s+/).filter(Boolean) : [];

    // 检查并装配社区驱动客户端 (解决 P1-03 依赖注入)
    const provider = this.providers.get(plugin.community);
    if (!provider && plugin.community) {
      await event.reply(`[Game-Hub] 警告: 未找到游戏 [${plugin.name}] 所需的社区驱动 [${plugin.community}]。`);
      return "return";
    }

    // 查询当前用户在此游戏下激活的默认角色与凭据 (解决 P1-06)
    const activeRole = this.vault ? this.vault.getActiveRole(event.unifiedUserId, gameId) : null;

    // 构造专用于该用户的驱动请求客户端 (解决 P1-03)
    let client = null;
    if (provider && typeof provider.createClient === "function") {
      client = provider.createClient(activeRole?.cookies || {}, activeRole?.device || {});
    } else {
      client = provider;
    }

    /** @type {import('../types.mjs').IGameContext} */
    const ctx = {
      event,
      gameId,
      matchedToken,
      args,
      activeRole,
      client,
      vault: this.vault,
      provider
    };

    // 执行业务路由 Action
    try {
      const result = await bestRoute.action(ctx);
      if (result === "return" || result === true) {
        return "return";
      }
      return "return";
    } catch (err) {
      console.error(`[Game-Hub Dispatcher Error in ${gameId}:${bestRoute.id}]`, err);
      await event.reply(`[${plugin.name}] 执行错误: ${err?.message || "未知异常"}`);
      return "return";
    }
  }
}

export default GameHubDispatcher;
