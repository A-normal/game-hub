import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GameHubDispatcher } from "../dispatcher/dispatcher.mjs";
import {validateConfig} from "./config-schema.mjs";

function resolveEnvironment(value, env) {
  if (Array.isArray(value)) return value.map(item => resolveEnvironment(item, env));
  if (value && typeof value === "object") {
    if (Object.hasOwn(value, "$env")) {
      const resolved = env[value.$env] ?? value.default;
      if (resolved === undefined && value.required) throw new Error("缺少环境变量: " + value.$env);
      if(value.as==="number")return Number(resolved);
      return resolved;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveEnvironment(item, env)]));
  }
  return value;
}

/** Import only explicitly enabled local modules under their declared category. */
export async function assembleModules({ root, config, vault, env = process.env, importModule = url => import(url), adminToken }) {
  if (config.version !== 1 || !Array.isArray(config.modules)) throw new Error("无效模块配置版本");
  const dispatcher = new GameHubDispatcher({ vault, adminToken, env });
  const resolvedRoot = await fs.realpath(root);
  const channels = [];
  const disposables = [];
  let stopped = false;
  let started = false;
  const ids = new Set();
  const modules = config.modules.filter(item => item.enabled !== false);
  const declarations = [];
  // Preflight every descriptor before importing any enabled module.
  for (const item of modules) {
    if (!["channel", "provider", "plugin"].includes(item.kind) || !/^[a-z][a-z0-9-]*$/.test(item.id)) throw new Error("无效模块声明");
    const key = item.kind + ":" + item.id;
    if (ids.has(key)) throw new Error("重复模块: " + key);
    ids.add(key);
    const category = path.join(resolvedRoot, "packages", item.kind) + path.sep;
    const entry = await fs.realpath(path.resolve(resolvedRoot, item.entry));
    if (!entry.startsWith(category)) throw new Error("模块入口必须位于对应 packages 分类下: " + key);
    declarations.push({ item, entry, options: resolveEnvironment(item.config || {}, env) });
  }
  const runtime = {
    dispatcher, channels,
    async start() {
      if (started) return;
      if (stopped) throw new Error("Runtime already stopped");
      started = true;
      try { for (const resource of disposables) await resource.start?.(); }
      catch (error) { try {await runtime.stop();}catch(cleanup){throw new AggregateError([error,cleanup],"模块启动及清理失败");} throw error; }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      const errors = [];
      for (const resource of [...disposables].reverse()) {
        try { await resource.stop?.(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "模块关闭失败");
    }
  };
  try {
    for (const kind of ["provider", "plugin", "channel"]) {
      for (const { item, entry, options } of declarations.filter(value => value.item.kind === kind)) {
        const module = await importModule(pathToFileURL(entry).href);
        const create = module.createModule;
        if (typeof create !== "function") throw new Error("模块缺少 createModule: " + item.id);
        validateConfig(module.configSchema,options,item.kind+":"+item.id);
        const instance = await create({ config: options, dispatcher, vault });
        if(instance && typeof instance==="object")disposables.push(instance);
        if (!instance || instance.id !== item.id || instance.kind !== kind || instance.contractVersion !== 1) throw new Error("模块契约不匹配: " + item.id);
        if (kind === "provider") dispatcher.registerProvider(instance);
        if (kind === "plugin") {
          dispatcher.registerPlugin({ ...instance, config: options,shortcuts:item.shortcuts || [] });
          if (item.namespace && !vault?.getSetting("namespace:" + item.id)) dispatcher.setNamespace(item.id, item.namespace);
        }
        if (kind === "channel") { channels.push(instance); dispatcher.registerChannel(instance); }
      }
      if (kind === "plugin") dispatcher.validateDependencies();
    }
  } catch (error) {try {await runtime.stop();}catch(cleanup){throw new AggregateError([error,cleanup],"模块装配及清理失败");} throw error; }
  return runtime;
}
