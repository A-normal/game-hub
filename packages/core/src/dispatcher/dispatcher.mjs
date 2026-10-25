import crypto from "node:crypto";
import { logger } from "../logger/logger.mjs";
import { InboundShaper } from "../shaper/inbound-shaper.mjs";

export const RouteStatus = Object.freeze({ NOT_MATCHED: "NOT_MATCHED", HANDLED: "HANDLED", FAILED: "FAILED", DENIED: "DENIED" });
const result = status => ({ status });
const normalizedNamespace = config => ({
  prefix: String(config.prefix ?? ""),
  aliases: [...new Set((config.aliases || []).map(String).filter(Boolean))],
  priority: Number(config.priority ?? 50)
});

export class GameHubDispatcher {
  constructor({ vault = null, adminToken, adminUsers = [] } = {}) {
    this.vault = vault;
    this.adminToken = adminToken ?? process.env.GAMEHUB_TOKEN ?? process.env.ACCESS_TOKEN ?? "";
    this.plugins = new Map();
    this.providers = new Map();
    this.channels = new Map();
    this.shortcuts = new Map();
    this.pluginStates = new Map();
    this.namespaces = new Map();
    this.adminUsers = new Set(adminUsers);
    this.startTime = Date.now();
    for (const id of (process.env.GAMEHUB_ADMIN_USERS || process.env.MASTER_QQ || "").split(/[,，;]/).filter(Boolean)) this.adminUsers.add(id);
    this._restorePersistedSettings();
    this._registerSystemPlugin();
  }

  _restorePersistedSettings() {
    if (!this.vault) return;
    for (const [key, value] of Object.entries(this.vault.getAllSettings("namespace:"))) {
      if (value && typeof value === "object") this.namespaces.set(key.slice(10), normalizedNamespace(value));
    }
    for (const [key, value] of Object.entries(this.vault.getAllSettings("plugin_state:"))) this.pluginStates.set(key.slice(13), typeof value === "object" ? Boolean(value.enabled) : Boolean(value));
    for (const id of this.vault.getSetting("system:admin_users", [])) this.adminUsers.add(String(id));
  }

  isAdmin(event) {
    if (!event) return false;
    if (this.adminUsers.has(event.unifiedUserId)) return true;
    const raw = event.sender?.id ?? event.originalId;
    return raw !== undefined && this.adminUsers.has(String(raw));
  }
  addAdmin(id) {
    if (!id) return false;
    this.adminUsers.add(String(id));
    this.vault?.setSetting("system:admin_users", [...this.adminUsers]);
    return true;
  }
  removeAdmin(id) {
    const deleted = this.adminUsers.delete(String(id));
    this.vault?.setSetting("system:admin_users", [...this.adminUsers]);
    return deleted;
  }

  registerProvider(provider) {
    if (!provider?.id || this.providers.has(provider.id)) throw new Error("Invalid or duplicate provider");
    this.providers.set(provider.id, provider);
  }
  registerChannel(channel) { if (this.channels.has(channel.id)) throw new Error("Duplicate channel"); this.channels.set(channel.id,channel); }
  async deliver(target, content) {
    const candidates=[...this.channels.values()].filter(channel=>channel.platforms?.includes(target.platform));
    if (candidates.length!==1 || typeof candidates[0].send!=="function") throw Object.assign(new Error("No unambiguous delivery channel"),{code:"DELIVERY_UNAVAILABLE"});
    const result=await candidates[0].send(target,content);
    if (result?.success===false) throw new Error("Delivery failed");
    return result;
  }
  registerPlugin(manifest) {
    const id = manifest?.id || manifest?.gameId;
    if (!id || this.plugins.has(id) || !Array.isArray(manifest.routes)) throw new Error("Invalid or duplicate plugin");
    const plugin = { ...manifest, id };
    const ns=this.namespaces.get(id) || normalizedNamespace(plugin.defaultNamespace || {aliases:[id]});
    const conflicts=this.checkNamespaceConflicts(id,ns.prefix,ns.aliases);
    if(!conflicts.valid)throw new Error("Namespace conflict for "+id+": "+conflicts.errors.join("; "));
    const routeIds = new Set();
    for (const route of plugin.routes) {
      if (!route.id || routeIds.has(route.id) || typeof route.action !== "function") throw new Error("Invalid or duplicate route in " + id);
      routeIds.add(route.id);
    }
    for(const shortcut of plugin.shortcuts || []) {
      const route=plugin.routes.find(row=>row.id===shortcut.routeId && (!row.stage || row.stage==="command"));
      if(!route || !shortcut.text || shortcut.text!==shortcut.text.trim() || this.shortcuts.has(shortcut.text))throw new Error("Invalid or conflicting shortcut in "+id);
      this.shortcuts.set(shortcut.text,{...shortcut,pluginId:id,route});
    }
    this.plugins.set(id, plugin);
    if (!this.pluginStates.has(id)) this.pluginStates.set(id, true);
    if (!this.namespaces.has(id)) this.namespaces.set(id, normalizedNamespace(plugin.defaultNamespace || { aliases: [id] }));
  }
  validateDependencies() {
    for (const plugin of this.plugins.values()) {
      if (!this.isPluginEnabled(plugin.id)) continue;
      for (const dependency of plugin.providers || []) {
        const provider = this.providers.get(dependency.id);
        if (!provider && !dependency.optional) throw new Error(plugin.id + ": missing provider " + dependency.id);
        for (const capability of dependency.capabilities || []) {
          if (provider && !provider.capabilities?.includes(capability)) throw new Error(plugin.id + ": missing capability " + capability);
        }
      }
    }
  }
  enablePlugin(id) {
    if (!this.plugins.has(id)) return false;
    this.pluginStates.set(id, true);
    try { this.validateDependencies(); } catch (error) { this.pluginStates.set(id, false); throw error; }
    this.vault?.setSetting("plugin_state:" + id, { enabled: true });
    return true;
  }
  disablePlugin(id) {
    if (!this.plugins.has(id) || id === "system") return false;
    this.pluginStates.set(id, false);
    this.vault?.setSetting("plugin_state:" + id, { enabled: false });
    return true;
  }
  isPluginEnabled(id) { return this.pluginStates.get(id) !== false; }
  getNamespace(id) {
    const ns = this.namespaces.get(id);
    return ns ? { ...ns, aliases: [...ns.aliases] } : null;
  }
  checkNamespaceConflicts(id, prefix, aliases = []) {
    const errors = [];
    const warnings = [];
    // 前缀与别名是等价的调用标记：`%帮助` = `zzz帮助` = `绝帮助`。
    // 别名重名会让同一句话落到两个插件，属硬冲突；前缀共享保留为警告，由优先级消歧。
    const mine = new Set([prefix, ...aliases].filter(Boolean).map(value => String(value).toLowerCase()));
    for (const [otherId, ns] of this.namespaces) {
      if (otherId === id || !this.plugins.has(otherId)) continue;
      const theirAliases = new Set(ns.aliases.map(value => String(value).toLowerCase()));
      const theirMarkers = new Set([ns.prefix, ...ns.aliases].filter(Boolean).map(value => String(value).toLowerCase()));
      const aliasHit = aliases.map(String).filter(alias => theirMarkers.has(alias.toLowerCase()));
      if (aliasHit.length) errors.push("别名与插件 " + otherId + " 的命名空间重叠: " + aliasHit.join("、"));
      else if (prefix && theirAliases.has(String(prefix).toLowerCase())) errors.push("前缀与插件 " + otherId + " 的别名重叠: " + prefix);
      const shared = [...mine].filter(value => value === String(ns.prefix).toLowerCase());
      if (shared.length) warnings.push("与插件 " + otherId + " 共享前缀 " + ns.prefix + "，按优先级消歧");
    }
    if (!prefix && !aliases.length) errors.push("前缀与别名不能同时为空");
    return { valid: !errors.length, errors, warnings };
  }
  setNamespace(id, config) {
    if (!this.plugins.has(id)) throw new Error("插件不存在: " + id);
    const current = this.getNamespace(id);
    const proposed = normalizedNamespace({ ...current, ...config });
    const check = this.checkNamespaceConflicts(id, proposed.prefix, proposed.aliases);
    if (!check.valid) throw new Error(check.errors.join("; "));
    this.namespaces.set(id, proposed);
    this.vault?.setSetting("namespace:" + id, proposed);
    return { updated: this.getNamespace(id), warnings: check.warnings };
  }
  /** 该插件接受的全部调用标记，最长优先；前缀与别名等价，各自独立使用。 */
  markersOf(id) {
    const ns = this.getNamespace(id);
    if (!ns) return [];
    return [...new Set([ns.prefix, ...ns.aliases].filter(Boolean).map(String))].sort((a, b) => b.length - a.length);
  }

  commandPrefix(id) {
    const ns = this.getNamespace(id);
    if (!ns || !this.isPluginEnabled(id)) throw new Error("命令所属插件未启用: " + id);
    // 前缀与别名等价，提示里用配置的主前缀（没有前缀时退回首个别名）。
    const marker = ns.prefix || ns.aliases[0];
    if (!marker) throw new Error("没有可用命名空间: " + id);
    return marker;
  }
  formatCommand({ pluginId, routeId, args = [] }) {
    const plugin = this.plugins.get(pluginId);
    const route = plugin?.routes.find(item => item.id === routeId);
    if (!route || route.stage && route.stage !== "command") throw new Error("没有可调用的命令: " + pluginId + ":" + routeId);
    const token = route.tokens?.find(Boolean);
    if (!token) throw new Error("命令缺少词元");
    const primary = this.commandPrefix(pluginId);
    for (const marker of [...new Set([primary,...this.markersOf(pluginId)])]) {
      const glue = !(/[a-z0-9]$/i.test(marker) && /^[a-z0-9]/i.test(token));
      const text = marker + (glue ? "" : " ") + token + (args.length ? " " + args.map(String).join(" ") : "");
      const target=this.resolveNamespaceCandidates(text).find(candidate=>this._matchCommand(this.plugins.get(candidate.gameId),candidate.commandText));
      if(target?.gameId===pluginId && this._matchCommand(plugin,target.commandText)?.route.id===routeId) return text;
    }
    throw new Error("命名空间冲突，无法生成可用命令: "+pluginId+":"+routeId);
  }
  _matchCommand(plugin, text) {
    let best;
    for (const route of plugin?.routes || []) {
      if(route.stage && route.stage!=="command") continue;
      for(const token of route.tokens || []) {
        const match=route.exact ? text===token : text.startsWith(token);
        if(match && (token || !text) && (!best || token.length>best.token.length)) best={route,token,tail:text.slice(token.length).trim()};
      }
      for(const suffix of route.suffixTokens || []) if(text.endsWith(suffix) && text.length>suffix.length && (!best || suffix.length>best.token.length)) best={route,token:suffix,tail:text.slice(0,-suffix.length).trim()};
    }
    return best;
  }
  listPlugins() {
    return [...this.plugins.values()].map(plugin => ({
      gameId: plugin.id, id: plugin.id, name: plugin.name, community: plugin.community || plugin.providers?.[0]?.id || "",
      enabled: this.isPluginEnabled(plugin.id), routesCount: plugin.routes.length, ...this.getNamespace(plugin.id)
    }));
  }
  listProviders() {
    return [...this.providers.values()].map(provider => ({
      id: provider.id, name: provider.name,
      linkedPlugins: [...this.plugins.values()].filter(plugin => plugin.community === provider.id || plugin.providers?.some(dep => dep.id === provider.id)).map(plugin => plugin.name),
      status: "已挂载就绪"
    }));
  }
  resolveNamespaceCandidates(text) {
    const candidates = [];
    const body = String(text || "").trim();
    for (const [id, ns] of this.namespaces) {
      if (!this.isPluginEnabled(id)) continue;
      // 前缀与别名都是独立的调用标记：命中任意一个后，紧跟其后的内容才是命令词元。
      for (const marker of this.markersOf(id)) {
        if (!body.toLowerCase().startsWith(marker.toLowerCase())) continue;
        const rest = body.slice(marker.length);
        // 拉丁标记不能粘在拉丁单词上（ghost 不等于 gh + ost）。
        if (/[a-z0-9]$/i.test(marker) && /^[a-z0-9]/i.test(rest)) continue;
        candidates.push({ gameId: id, commandText: rest.trimStart(), priority: ns.priority, marker });
        break;
      }
    }
    return candidates.sort((a, b) => b.priority - a.priority || a.gameId.localeCompare(b.gameId));
  }

  _context(event, plugin, route, matchedToken, args, argumentText = args.join(" ")) {
    const providerId = route.provider || plugin.providers?.[0]?.id || plugin.community;
    const provider = this.providers.get(providerId);
    let activeRole;
    let client;
    return {
      event, pluginId: plugin.id, gameId: plugin.gameId, routeId: route.id, matchedToken, args, argumentText, vault: this.vault, dispatcher: this, provider,
      config: plugin.config || {}, services: plugin.services || {},
      providers: { get: id => this.providers.get(id) },
      commands: { format: spec => this.formatCommand({ pluginId: plugin.id, ...spec }) },
      get activeRole() {
        if (activeRole === undefined) activeRole = plugin.gameId && this.vault ? this.vault.getActiveRole(event.unifiedUserId, plugin.gameId) : null;
        return activeRole;
      },
      get client() {
        if (client === undefined) client = provider?.createClient ? provider.createClient(this.activeRole?.cookies || {}, this.activeRole?.device || {}) : provider;
        return client;
      }
    };
  }
  async _execute(event, plugin, route, token, args, argumentText) {
    const ctx = this._context(event, plugin, route, token, args, argumentText);
    if (route.admin && !this.isAdmin(event)) {
      await event.reply("【权限拒绝】该指令仅限管理员执行。请私聊使用 " + this.formatCommand({ pluginId: "system", routeId: "auth", args: ["<Token>"] }));
      return result(RouteStatus.DENIED);
    }
    try {
      const output = await route.action(ctx);
      if (output?.status && Object.values(RouteStatus).includes(output.status)) return output;
      return result(output === false ? RouteStatus.NOT_MATCHED : RouteStatus.HANDLED);
    } catch (error) {
      // 记录真实失败原因（含业务错误码），凭据与授权链接在写入前统一脱敏。
      const detail = [error?.code || error?.name || "Error", error?.retcode !== undefined ? "retcode=" + error.retcode : "", InboundShaper.sanitizeLogText(error?.publicMessage || error?.message || "")].filter(Boolean).join(" ");
      logger.warn("Dispatcher", "路由失败: " + plugin.id + ":" + route.id + " — " + detail);
      await event.reply("【" + plugin.name + "】" + (error.publicMessage || "执行失败，请稍后重试。"));
      return result(RouteStatus.FAILED);
    }
  }
  async dispatch(event) {
    const text = String(event.cleanText || "").trim();
    const shortcuts=[...this.shortcuts].filter(([key,value])=>this.isPluginEnabled(value.pluginId) && (text===key || text.startsWith(key+" "))).sort((a,b)=>b[0].length-a[0].length);
    if(shortcuts.length) {
      const [key,shortcut]=shortcuts[0];
      const tail=text.slice(key.length).trim();
      const args=[...(shortcut.args || []),...(tail?tail.split(/\s+/):[])];
      const output=await this._execute(event,this.plugins.get(shortcut.pluginId),shortcut.route,shortcut.route.tokens[0],args,[...(shortcut.args || []),tail].filter(Boolean).join(" "));
      return output.status===RouteStatus.NOT_MATCHED ? result(RouteStatus.HANDLED) : output;
    }
    const candidates = this.resolveNamespaceCandidates(text);
    for (const candidate of candidates) {
      const plugin = this.plugins.get(candidate.gameId);
      if (!plugin) continue;
      const best=this._matchCommand(plugin,candidate.commandText);
      if (best) {
        const output = await this._execute(event, plugin, best.route, best.token, best.tail ? best.tail.split(/\s+/) : [],best.tail);
        if (output.status !== RouteStatus.NOT_MATCHED) return output;
      }
    }
    // Disabled plugin aliases also remain commands, never AI fallback input.
    const hasCommandMarker = [...this.namespaces.keys()].some(id => this.markersOf(id).some(marker => {
      if (!text.toLowerCase().startsWith(marker.toLowerCase())) return false;
      return !(/[a-z0-9]$/i.test(marker) && /^[a-z0-9]/i.test(text.slice(marker.length)));
    }));
    if (candidates.length || event.commandHint || hasCommandMarker) {
      await event.reply("未识别该命令，请使用已启用插件的帮助命令。");
      return result(RouteStatus.HANDLED);
    }
    for (const stage of ["text", "fallback"]) {
      for (const plugin of this.plugins.values()) {
        if (!this.isPluginEnabled(plugin.id)) continue;
        for (const route of plugin.routes.filter(item => item.stage === stage)) {
          if (route.match && !route.match(event)) continue;
          const output = await this._execute(event, plugin, route, "", []);
          if (output.status !== RouteStatus.NOT_MATCHED) return output;
        }
      }
    }
    return result(RouteStatus.NOT_MATCHED);
  }

  _registerSystemPlugin() {
    const route = (id, tokens, action, admin = true) => ({ id, tokens, action, admin });
    this.registerPlugin({
      id: "system", name: "Game-Hub 系统管理总线",
      defaultNamespace: { prefix: "#", aliases: ["#gh", "gh", "gamehub", "总线", "/gh"], priority: 999 },
      routes: [
        route("help", ["帮助", "help", "菜单", ""], async ctx => {
          const lines = ["【Game-Hub 总线管理指令手册 (管理员专用)】"];
          for (const [id, args] of [["status", []], ["plugins", []], ["enable", ["<插件ID>"]], ["disable", ["<插件ID>"]], ["namespace", ["<插件ID>", "<前缀>", "<别名列表>"]], ["admins", []], ["log", ["<级别>"]]]) lines.push(ctx.commands.format({ routeId: id, args }));
          await ctx.event.reply(lines.join("\n"));
        }),
        route("auth", ["认证", "auth", "绑定管理", "登录管理"], async ctx => {
          if (ctx.event.isGroup) { await ctx.event.reply("请在私聊中认证管理员。"); return result(RouteStatus.DENIED); }
          const input = ctx.args[0] || "";
          const supplied = Buffer.from(input);
          const expected = Buffer.from(this.adminToken);
          if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) { await ctx.event.reply("管理员认证失败：Token 错误或无效！"); return result(RouteStatus.DENIED); }
          this.addAdmin(ctx.event.unifiedUserId);
          await ctx.event.reply("【管理员认证成功】\n" + ctx.commands.format({ routeId: "help" }));
        }, false),
        route("status", ["状态", "status"], async ctx => {
          await ctx.event.reply("【Game-Hub 总线微内核运行状态】\n运行秒数: " + Math.floor((Date.now() - this.startTime) / 1000) + "\n插件: " + this.plugins.size + "\n社区驱动: " + this.providers.size + " 个 ([" + [...this.providers.keys()].join(",") + "])");
        }),
        route("plugins", ["插件列表", "plugins"], async ctx => {
          const lines = ["业务插件 (Plugins)"];
          for (const plugin of this.listPlugins()) lines.push(plugin.name + " (" + plugin.id + ") " + (plugin.enabled ? "启用" : "禁用"));
          lines.push("社区数据驱动 (Community Providers)");
          for (const provider of this.listProviders()) lines.push(provider.name + " (" + provider.id + ") | 服务插件: " + provider.linkedPlugins.join("、"));
          await ctx.event.reply(lines.join("\n"));
        }),
        route("enable", ["启用", "enable"], async ctx => { await ctx.event.reply(this.enablePlugin(ctx.args[0]) ? "已成功启用插件" : "插件不存在"); }),
        route("disable", ["禁用", "disable"], async ctx => { await ctx.event.reply(this.disablePlugin(ctx.args[0]) ? "已禁用插件" : "插件不存在或不可禁用"); }),
        route("namespace", ["命名空间", "namespace"], async ctx => {
          try {
            if (ctx.args.length < 2) {
              await ctx.event.reply("用法: " + ctx.commands.format({ routeId: "namespace", args: ["<插件ID>", "<前缀或空字符串>", "[别名列表]"] }) + "\n前缀与别名等价，都是独立调用标记：<前缀>帮助 与 <别名>帮助 效果相同。\n只改前缀时可省略别名；别名用逗号分隔，留空表示只保留前缀。");
              return;
            }
            const prefix = ["''", '""'].includes(ctx.args[1]) ? "" : ctx.args[1];
            const current = this.getNamespace(ctx.args[0]);
            if (!current) { await ctx.event.reply("命名空间更新被拒绝：插件 " + ctx.args[0] + " 不存在或未启用。"); return; }
            const aliases = ctx.args[2] === undefined ? [...current.aliases] : ["''", '""'].includes(ctx.args[2]) ? [] : ctx.args[2].split(/[,，]/).map(value => value.trim()).filter(Boolean);
            const updated = this.setNamespace(ctx.args[0], { prefix, aliases });
            const sampleRoute = this.plugins.get(ctx.args[0])?.routes.find(row => row.tokens?.some(Boolean));
            const token = sampleRoute?.tokens?.find(Boolean) || "";
            const forms = [updated.updated.prefix, ...updated.updated.aliases].filter(Boolean).map(marker => marker + token);
            await ctx.event.reply([
              "命名空间已更新",
              "前缀: " + JSON.stringify(updated.updated.prefix),
              "别名: " + (updated.updated.aliases.length ? updated.updated.aliases.join("、") : "无"),
              forms.length ? "等价调用: " + forms.join(" = ") : "",
              updated.warnings.length ? "提示：" + updated.warnings.join("；") : ""
            ].filter(Boolean).join("\n"));
          } catch (error) {
            await ctx.event.reply("命名空间更新被拒绝：" + (error.publicMessage || error.message || "请检查插件ID、别名冲突和参数。"));
          }
        }),
        route("admins", ["管理员列表", "admins"], async ctx => { await ctx.event.reply("管理员列表:\n" + [...this.adminUsers].join("\n")); }),
        route("addAdmin", ["添加管理"], async ctx => { await ctx.event.reply(this.addAdmin(ctx.args[0]) ? "已添加管理员" : "请提供用户标识"); }),
        route("removeAdmin", ["移除管理"], async ctx => { await ctx.event.reply(this.removeAdmin(ctx.args[0]) ? "已移除管理员" : "未找到管理员"); }),
        route("log", ["日志级别"], async ctx => {
          const level = String(ctx.args[0] || "").toUpperCase();
          if (!["DEBUG", "INFO", "WARN", "ERROR", "SILENT"].includes(level)) { await ctx.event.reply("级别可选 DEBUG / INFO / WARN / ERROR / SILENT"); return; }
          logger.setLevel(level);
          await ctx.event.reply("日志级别已更新");
        })
      ]
    });
  }
}
export default GameHubDispatcher;
