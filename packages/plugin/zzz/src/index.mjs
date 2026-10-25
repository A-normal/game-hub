export * from "./manifest.mjs";
export * from "./handlers/bind.mjs";
export * from "./handlers/login-qr.mjs";
export * from "./handlers/role.mjs";
export * from "./handlers/note.mjs";
export * from "./handlers/panel.mjs";
export * from "./handlers/abyss.mjs";
export * from "./handlers/sign.mjs";
export * from "./handlers/gacha.mjs";
export * from "./handlers/help.mjs";
export * from "./utils/qr-encoder.mjs";
import { ZZZPluginManifest } from "./manifest.mjs";
import { ZzzStore } from "./storage.mjs";
import { ZzzTasks } from "./tasks.mjs";
export const configSchema={type:"object",additionalProperties:false,properties:{panelCooldownMs:{type:"number",minimum:1000,maximum:86400000},aliases:{type:"object",additionalProperties:{type:"string",maxLength:80}},scoring:{type:"object"},damageRules:{type:"object"},damageScenario:{type:"object"},calculationScenario:{type:"object"},content:{type:"object"}}};
export default ZZZPluginManifest;
export function createModule({config={},vault,dispatcher}) {
  const store=new ZzzStore(vault);
  const tasks=new ZzzTasks({store,vault,dispatcher});
  return {...ZZZPluginManifest,config,services:{store,tasks},start:()=>tasks.start(),stop:()=>tasks.stop()};
}
