import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GameHubDispatcher, IdentityVault, assembleModules, isQualifiedUserId, Logger } from "../packages/core/src/index.mjs";
import { bootstrap } from "../app.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const registration = "fixture-registration-secret";
let sequence = 0;
function event(text = "", { platform = "telegram", userId = "123456789", ...extra } = {}) {
  return {
    eventId: "admin-event-" + (++sequence), messageId: String(sequence),
    platform, unifiedUserId: `${platform}:${userId}`, sender: { id: userId },
    isGroup: false, cleanText: text, reply: async () => ({ success: true }), ...extra
  };
}
function harness(t, options = {}) {
  const vault = options.vault ?? new IdentityVault();
  if (!options.vault) t.after(() => vault.close());
  const d = new GameHubDispatcher({ vault, env: { GAMEHUB_ADMIN_REGISTRATION_TOKEN: registration }, ...options });
  const replies = [];
  const send = async (text, overrides = {}) => d.dispatch(event(text, {
    reply: async value => { replies.push(String(value)); return { success: true }; }, ...overrides
  }));
  const command = (routeId, args = []) => d.formatCommand({ pluginId: "system", routeId, args });
  return { d, vault, replies, send, command };
}

test("registration authorizes the real sender globally but does not inherit the same numeric ID on another platform", async t => {
  const { d, vault, send, command } = harness(t);
  assert.equal((await send(command("auth", [registration]))).status, "HANDLED");
  assert.equal(d.isAdmin(event()), true);
  assert.equal(d.isAdmin(event("", { platform: "qq-napcat" })), false);
  assert.equal((await send(command("status"))).status, "HANDLED");
  assert.deepEqual(vault.getSetting("system:admin_users"), ["telegram:123456789"]);
  await send(command("auth", [registration]), { platform: "qq-napcat" });
  assert.equal(d.isAdmin(event("", { platform: "qq-napcat" })), true);
  assert.deepEqual(new Set(vault.getSetting("system:admin_users")), new Set(["telegram:123456789", "qq-napcat:123456789"]));
});

test("transport, obsolete and AI tokens do not authorize system administrators", async t => {
  const env = {
    GAMEHUB_ADMIN_REGISTRATION_TOKEN: registration, NAPCAT_TO_GAMEHUB_CONNECTION_TOKEN: "transport-token",
    GAMEHUB_TOKEN: "legacy-transport-token", ACCESS_TOKEN: "old-access-token", GAMEHUB_ADMIN_TOKEN: "old-admin-token", CHATAI_ADMIN_REGISTRATION_TOKEN: "ai-token"
  };
  const { d, vault, send, command } = harness(t, { env });
  for (const token of ["transport-token", "legacy-transport-token", "old-access-token", "old-admin-token", "ai-token", "incorrect-token"]) {
    assert.equal((await send(command("auth", [token]))).status, "DENIED");
    assert.equal(d.isAdmin(event()), false);
  }
  assert.deepEqual(vault.getSetting("system:admin_users", []), []);
  assert.equal((await send(command("auth", [registration]))).status, "HANDLED");
  assert.equal(Object.hasOwn(d, "adminToken"), false);
  assert.ok(!JSON.stringify(d.administration).includes(registration));
});

test("registration is disabled without its own token even when connection credentials exist", async t => {
  for (const token of [undefined, ""]) {
    const { d, vault, send, command, replies } = harness(t, { env: {
      GAMEHUB_ADMIN_REGISTRATION_TOKEN: token, NAPCAT_TO_GAMEHUB_CONNECTION_TOKEN: "connection-secret", GAMEHUB_TOKEN: "legacy-connection-secret", ACCESS_TOKEN: "old-secret", MASTER_QQ: "123456789"
    } });
    assert.equal((await send(command("auth", ["connection-secret"]))).status, "DENIED");
    assert.match(replies.at(-1), /注册未开启.*GAMEHUB_ADMIN_REGISTRATION_TOKEN/);
    assert.equal(d.isAdmin(event()), false);
    assert.deepEqual(vault.getSetting("system:admin_users", []), []);
  }
});

test("registration refuses groups, missing or extra arguments and inconsistent identities without writing or reaching AI", async t => {
  const { d, vault, send, command, replies } = harness(t);
  let observed = 0, fallback = 0;
  d.registerPlugin({ id: "probe", name: "Probe", defaultNamespace: { prefix: "!", aliases: [] }, routes: [
    { id: "observe", stage: "observer", action: () => { observed++; } },
    { id: "fallback", stage: "fallback", action: () => { fallback++; } }
  ] });
  for (const [args, overrides] of [
    [[registration], { isGroup: true, groupId: "group" }],
    [[], {}], [[registration, "telegram:999"], {}], [["wrong"], {}],
    [[registration], { unifiedUserId: "telegram:999" }],
    [[registration], { platform: "qq-napcat", unifiedUserId: "telegram:123456789" }],
    [[registration], { sender: undefined }], [[registration], { unifiedUserId: "123456789" }]
  ]) assert.equal((await send(command("auth", args), overrides)).status, "DENIED");
  assert.equal(observed, 0); assert.equal(fallback, 0);
  assert.deepEqual(vault.getSetting("system:admin_users", []), []);
  assert.equal(d.isAdmin(event()), false);
  await send(command("auth", [registration]));
  assert.equal(observed, 0); assert.equal(fallback, 0);
  assert.ok(!replies.join("\n").includes(registration));
});

test("duplicate registration is idempotent and changed namespaces appear in prompts and success replies", async t => {
  const { d, vault, send, command, replies } = harness(t);
  const originalSet = vault.setSetting.bind(vault);
  let writes = 0;
  vault.setSetting = (...args) => { writes++; return originalSet(...args); };
  d.setNamespace("system", { prefix: "&", aliases: ["管理入口"] });
  const before = writes;
  await send(command("status"));
  assert.match(replies.at(-1), /&认证/);
  await send(command("auth", [registration]));
  assert.match(replies.at(-1), /&帮助/);
  assert.equal(writes, before + 1);
  await send(command("auth", [registration]));
  assert.equal(writes, before + 1);
  assert.match(replies.at(-1), /已是系统管理员/);
  assert.deepEqual(vault.getSetting("system:admin_users"), ["telegram:123456789"]);
  await send(command("help", ["认证"]));
  assert.match(replies.at(-1), /GAMEHUB_ADMIN_REGISTRATION_TOKEN/);
  assert.ok(!replies.join("\n").includes(registration));
});

test("registered grants persist across database reopen; rotation does not revoke, removal does", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gamehub-admin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "vault.db");
  let v = new IdentityVault(file);
  try {
    let d = new GameHubDispatcher({ vault: v, env: { GAMEHUB_ADMIN_REGISTRATION_TOKEN: registration } });
    await d.dispatch(event(d.formatCommand({ pluginId: "system", routeId: "auth", args: [registration] })));
    v.close(); v = new IdentityVault(file);
    d = new GameHubDispatcher({ vault: v, env: { GAMEHUB_ADMIN_REGISTRATION_TOKEN: "rotated-registration" } });
    assert.equal(d.isAdmin(event()), true);
    assert.equal((await d.dispatch(event(d.formatCommand({ pluginId: "system", routeId: "auth", args: [registration] }), { userId: "2" }))).status, "DENIED");
    assert.equal(d.addAdmin("telegram:2"), true);
    assert.equal(d.removeAdmin("telegram:123456789"), true);
    assert.equal(d.isAdmin(event()), false);
    assert.equal((await d.dispatch(event(d.formatCommand({ pluginId: "system", routeId: "status" })))).status, "DENIED");
    v.close(); v = new IdentityVault(file);
    d = new GameHubDispatcher({ vault: v, env: {} });
    assert.equal(d.isAdmin(event()), false);
    assert.equal(d.isAdmin(event("", { userId: "2" })), true);
    assert.ok(!JSON.stringify(v.getSetting("system:admin_users")).includes(registration));
  } finally { v.close(); }
});

test("environment preset administrators remain separate and cannot be falsely revoked or copied to the registered list", async t => {
  const { d, vault, send, command, replies } = harness(t, { env: {
    GAMEHUB_ADMIN_REGISTRATION_TOKEN: registration,
    GAMEHUB_ADMIN_USERS: "telegram:123456789, qq-napcat:7"
  } });
  assert.equal(d.isAdmin(event()), true);
  assert.deepEqual(vault.getSetting("system:admin_users", []), []);
  await send(command("auth", [registration]));
  assert.deepEqual(vault.getSetting("system:admin_users", []), []);
  await send(command("removeAdmin", ["telegram:123456789"]));
  assert.match(replies.at(-1), /环境配置预置.*当前权限未撤销/);
  assert.equal(d.isAdmin(event()), true);
  await send(command("addAdmin", ["telegram:2"]));
  assert.deepEqual(vault.getSetting("system:admin_users"), ["telegram:2"]);
  await send(command("admins"));
  assert.match(replies.at(-1), /telegram:123456789（环境预置）/);
  assert.match(replies.at(-1), /telegram:2（已注册）/);
  const rebuilt = new GameHubDispatcher({ vault, env: {} });
  assert.equal(rebuilt.isAdmin(event()), false);
  assert.equal(rebuilt.isAdmin(event("", { userId: "2" })), true);
  assert.equal(d.removeAdmin("telegram:123456789"), false);
});

test("legacy bare stored IDs are ignored without rewriting the data and cannot cross-authorize platforms", async t => {
  const v = new IdentityVault(); t.after(() => v.close());
  const original = ["123456789", "telegram:2", "telegram:3\n", null];
  v.setSetting("system:admin_users", original);
  const d = new GameHubDispatcher({ vault: v, env: {} });
  assert.equal(d.isAdmin(event()), false);
  assert.equal(d.isAdmin(event("", { platform: "qq-napcat" })), false);
  assert.equal(d.isAdmin({ sender: { id: "123456789" } }), false);
  assert.equal(d.isAdmin(event("", { userId: "2" })), true);
  assert.deepEqual(v.getSetting("system:admin_users"), original);
  assert.equal(d.addAdmin("123456789"), false);
  assert.equal(d.addAdmin("telegram:3\n"), false);
  for (const env of [{ GAMEHUB_ADMIN_USERS: "123456789" }, { GAMEHUB_ADMIN_REGISTRATION_TOKEN: "secret with spaces" }]) {
    assert.throws(() => new GameHubDispatcher({ vault: v, env }), /GAMEHUB_ADMIN_/);
  }
  assert.equal(isQualifiedUserId("telegram:3\n"), false);
});

test("failed durable writes leave effective permissions unchanged and hide storage error details", async t => {
  const { d, vault, send, command, replies } = harness(t);
  d.addAdmin("telegram:2");
  const persisted = vault.getSetting("system:admin_users");
  vault.setSetting = () => { throw new Error("private-storage-error-detail"); };
  assert.equal((await send(command("auth", [registration]))).status, "FAILED");
  assert.equal(d.isAdmin(event()), false);
  assert.equal(d.isAdmin(event("", { userId: "2" })), true);
  assert.throws(() => d.removeAdmin("telegram:2"), { code: "ADMIN_STORE_FAILED" });
  assert.equal(d.isAdmin(event("", { userId: "2" })), true);
  assert.deepEqual(vault.getSetting("system:admin_users"), persisted);
  assert.match(replies.at(-1), /权限变更未生效/);
  assert.ok(!replies.join("\n").includes("private-storage-error-detail"));
});

test("only existing system administrators can add or revoke other qualified identities", async t => {
  const { d, vault, send, command, replies } = harness(t);
  assert.equal((await send(command("addAdmin", ["telegram:2"]))).status, "DENIED");
  assert.equal((await send(command("removeAdmin", ["telegram:2"]))).status, "DENIED");
  await send(command("auth", [registration]));
  await send(command("addAdmin", ["2"]));
  assert.match(replies.at(-1), /完整的平台:用户ID/);
  assert.equal(d.isAdmin(event("", { userId: "2" })), false);
  await send(command("addAdmin", ["telegram:2"]));
  assert.equal(d.isAdmin(event("", { userId: "2" })), true);
  await send(command("removeAdmin", ["telegram:2"]));
  assert.equal(d.isAdmin(event("", { userId: "2" })), false);
  assert.deepEqual(vault.getSetting("system:admin_users"), ["telegram:123456789"]);
});

test("runtime assembly uses the provided environment instead of unrelated process secrets", async t => {
  const v = new IdentityVault(); t.after(() => v.close());
  const keys = ["GAMEHUB_ADMIN_REGISTRATION_TOKEN", "GAMEHUB_ADMIN_USERS"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.GAMEHUB_ADMIN_REGISTRATION_TOKEN = "ambient-token";
    process.env.GAMEHUB_ADMIN_USERS = "telegram:123456789";
    const r = await assembleModules({ root, vault: v, env: {}, config: { version: 1, modules: [] } });
    t.after(() => r.stop());
    assert.equal(r.dispatcher.isAdmin(event()), false);
    assert.equal(r.dispatcher.administration.registrationEnabled, false);
    const r2 = await assembleModules({ root, vault: v, env: { GAMEHUB_ADMIN_REGISTRATION_TOKEN: registration }, config: { version: 1, modules: [] } });
    t.after(() => r2.stop());
    assert.equal((await r2.dispatcher.dispatch(event(r2.dispatcher.formatCommand({ pluginId: "system", routeId: "auth", args: [registration] })))).status, "HANDLED");
  } finally {
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  }
});

test("application bootstrap reads registration environment and never repurposes accessToken", async t => {
  const app = await bootstrap({
    env: { GAMEHUB_DB: ":memory:", GAMEHUB_ADMIN_REGISTRATION_TOKEN: registration },
    config: { version: 1, modules: [] }, accessToken: "obsolete-connection-argument"
  });
  t.after(() => app.stop());
  const command = token => app.dispatcher.formatCommand({ pluginId: "system", routeId: "auth", args: [token] });
  assert.equal((await app.dispatcher.dispatch(event(command("obsolete-connection-argument")))).status, "DENIED");
  assert.equal((await app.dispatcher.dispatch(event(command(registration)))).status, "HANDLED");
});

test("registration configuration and command secrets are scrubbed from logs", () => {
  const lines = [], original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const log = new Logger({ level: 0 });
    log.info("test", { GAMEHUB_ADMIN_REGISTRATION_TOKEN: registration, NAPCAT_TO_GAMEHUB_CONNECTION_TOKEN: "connection-value", CHATAI_ADMIN_REGISTRATION_TOKEN: "ai-value", GAMEHUB_TOKEN: "legacy-connection-value", CHATAI_ADMIN_TOKEN: "legacy-ai-value" });
    log.warn("test", "&认证 " + registration);
    log.warn("test", "GAMEHUB_ADMIN_REGISTRATION_TOKEN=" + registration);
  } finally { console.log = original; }
  for (const value of [registration, "connection-value", "ai-value", "legacy-connection-value", "legacy-ai-value"]) assert.ok(!lines.join("\n").includes(value));
});

test("NapCat module consumes the explicit connection variable without starting any listener", async t => {
  const v = new IdentityVault(); t.after(() => v.close());
  const config = JSON.parse(fs.readFileSync(path.join(root, "config/modules.json"), "utf8"));
  const channel = config.modules.find(item => item.kind === "channel" && item.id === "napcat");
  const onlyChannel = { version: 1, modules: [channel] };
  const r = await assembleModules({ root, vault: v, config: onlyChannel, env: { NAPCAT_TO_GAMEHUB_CONNECTION_TOKEN: "explicit-connection-value" } });
  t.after(() => r.stop());
  assert.equal(r.channels[0].accessToken, "explicit-connection-value");
  assert.equal(r.channels[0].server, null);
  assert.equal(r.dispatcher.administration.registrationEnabled, false);
  await assert.rejects(assembleModules({ root, vault: v, config: onlyChannel, env: { GAMEHUB_TOKEN: "legacy-value" } }), /NAPCAT_TO_GAMEHUB_CONNECTION_TOKEN/);
});
