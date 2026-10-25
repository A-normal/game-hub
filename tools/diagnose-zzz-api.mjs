/**
 * 只读线上诊断工具：核对 zzz 插件各业务指令在真实账号上的接口结果。
 *
 * 用法（宿主机）：
 *   docker cp tools/diagnose-zzz-api.mjs gamehub-service:/tmp/diagnose-zzz-api.mjs
 *   docker exec -e DIAG_DB=/app/data/vault.db -e DIAG_USER=qq-napcat:<QQ号> gamehub-service node /tmp/diagnose-zzz-api.mjs
 *
 * SQLite 强制 readOnly，不初始化表或执行迁移；不打印凭据值。
 * 诊断结论（2026-10-25 实测）见仓库根目录 GAME_HUB_ZZZ_LIVE_ISSUES_REPORT_*.md。
 */
import { IdentityVault } from "/app/packages/core/src/identity/vault.mjs";
import { MihoyoTakumiClient, RECORDS } from "/app/packages/provider/mihoyo/src/client.mjs";

const dbPath = process.env.DIAG_DB || process.env.GAMEHUB_DB || "/app/data/vault.db";
const userId = process.env.DIAG_USER || "";
if (!userId) throw new Error("请显式设置 DIAG_USER；不会猜测或列出其它用户。");
const vault = new IdentityVault(dbPath, {readOnly:true});
const out = line => console.log(line);
const summarize = data => {
  if (!data || typeof data !== "object") return typeof data;
  const keys = Object.keys(data);
  return keys.slice(0, 6).join(",") + (keys.length > 6 ? "…" : "");
};

out("== 已持久化的命名空间 / 插件状态 ==");
for (const [key, value] of Object.entries(vault.getAllSettings("namespace:"))) out(key + " => " + JSON.stringify(value));
for (const [key, value] of Object.entries(vault.getAllSettings("plugin_state:"))) out(key + " => " + JSON.stringify(value));

const active = vault.getActiveRole(userId, "zzz");
if (!active) {
  out("!! 指定用户没有激活角色；诊断终止，不切换到其它账号。");
  vault.close(); process.exit(2);
}

out("== 当前激活角色 ==");
out(JSON.stringify({ uid: active.uid, region: active.region, nickname: active.nickname, level: active.level }));
const jar = (active.cookies?.ck || "").split(";").map(pair => pair.split("=")[0].trim()).filter(Boolean);
out("== 凭据概况（只列键名与长度）==");
out("cookie 键: " + jar.join(", ") + " | 总长度=" + String(active.cookies?.ck || "").length);
out("device 键: " + Object.keys(active.device || {}).join(", ") + " | device_id 长度=" + String(active.device?.device_id || "").length);

const client = new MihoyoTakumiClient(active.cookies, active.device, {});
out("== 战绩 / 资料接口矩阵 ==");
for (const type of Object.keys(RECORDS)) {
  const started = Date.now();
  try {
    const data = await client.record(type, active.uid, active.region, type === "avatar" ? { id_list: [], need_wiki: true } : {});
    out("[OK ] " + type.padEnd(14) + " " + String(Date.now() - started).padStart(5) + "ms " + summarize(data));
  } catch (error) {
    out("[ERR] " + type.padEnd(14) + " " + String(Date.now() - started).padStart(5) + "ms code=" + error.code + " retcode=" + error.retcode + " " + (error.publicMessage || ""));
  }
}
out("== 其它接口 ==");
for (const [name, run] of [
  ["monthly", () => client.monthly(active.uid, active.region)],
  ["signInfo", () => client.signInfo(active.uid, active.region)],
  ["authKey", () => client.authKey(active.uid, active.region)]
]) {
  const started = Date.now();
  try {
    const data = await run();
    out("[OK ] " + name.padEnd(14) + " " + String(Date.now() - started).padStart(5) + "ms " + (name === "authKey" ? "authkey 已返回（不打印）" : summarize(data)));
  } catch (error) {
    out("[ERR] " + name.padEnd(14) + " " + String(Date.now() - started).padStart(5) + "ms code=" + error.code + " retcode=" + error.retcode + " " + (error.publicMessage || ""));
  }
}
out("== 公开展柜 (Enka) ==");
try {
  const started = Date.now();
  const response = await fetch("https://enka.network/api/zzz/uid/" + active.uid, { headers: { "User-Agent": "Game-Hub/1.0" }, redirect:"error", signal:AbortSignal.timeout(15000) });
  out("enka HTTP " + response.status + " " + (Date.now() - started) + "ms");
} catch (error) {
  out("[NET] enka " + error.name + " " + (error.cause?.code || error.message));
}
vault.close();
