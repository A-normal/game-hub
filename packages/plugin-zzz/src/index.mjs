/**
 * @file packages/plugin-zzz/src/index.mjs
 * @description 绝区零纯业务插件标准导出
 */

export * from "./manifest.mjs";
export * from "./handlers/bind.mjs";
export * from "./handlers/role.mjs";
export * from "./handlers/note.mjs";

import { ZZZPluginManifest } from "./manifest.mjs";
export default ZZZPluginManifest;
