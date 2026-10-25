import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IdentityVault, assembleModules } from "./packages/core/src/index.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

export async function bootstrap(options = {}) {
  const dbPath = options.dbPath || process.env.GAMEHUB_DB || path.join(root, "data/vault.db");
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const config = options.config || JSON.parse(fs.readFileSync(options.configPath || process.env.GAMEHUB_CONFIG || path.join(root, "config/modules.json"), "utf8"));
  const vault = new IdentityVault(dbPath);
  let runtime;
  try {
    runtime = await assembleModules({ root, config, vault, env: options.env || process.env, adminToken: options.accessToken });
    await runtime.start();
  } catch (error) { vault.close(); throw error; }
  let stopped = false;
  return {
    vault, dispatcher: runtime.dispatcher, channels: runtime.channels,
    async stop() {
      if (stopped) return;
      stopped = true;
      try { await runtime.stop(); } finally { vault.close(); }
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let application;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await application?.stop();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  bootstrap().then(async instance => {
    application = instance;
    if (stopping) await instance.stop();
  }).catch(error => { console.error("Game-Hub 启动失败: " + error.message); process.exitCode = 1; });
}
