import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { IdentityVault, GameHubDispatcher, assembleModules } from "../packages/core/src/index.mjs";
import { TelegramChannel, shapeUpdate } from "../packages/channel/telegram/src/index.mjs";
import { createModule as createChat } from "../packages/plugin/chat-ai/src/index.mjs";
import { ZZZPluginManifest } from "../packages/plugin/zzz/src/manifest.mjs";
import { ZzzStore } from "../packages/plugin/zzz/src/storage.mjs";

const bot = { id: 100, is_bot: true, username: "GameHubBot", can_read_all_group_messages: true };
let seq = 0;
const message = (text, extra = {}) => ({ update_id: ++seq, message: { message_id: seq, date: 1700000000, from: { id: 7, first_name: "Test" }, chat: { id: 7, type: "private" }, text, ...extra } });
const ok = result => Response.json({ ok: true, result });
const pause = async check => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); } assert.fail("integration completion timed out"); };

test("Telegram Bot API → core registration → real AI card import → multipart file export", async t => {
  const vault = new IdentityVault();
  const d = new GameHubDispatcher({ vault, env: { GAMEHUB_ADMIN_REGISTRATION_TOKEN: "registration-value" } });
  const p = createChat({ vault, dispatcher: d, config: {} }); d.registerPlugin(p);
  const card = JSON.stringify({ name: "通用导入卡", description: "独立编写的 Telegram 集成测试角色。" });
  const updates = [message(d.formatCommand({ pluginId: "system", routeId: "auth", args: ["registration-value"] })), message(d.formatCommand({ pluginId: "chat-ai", routeId: "characterImport" })), message(undefined, { document: { file_id: "card-file", file_name: "card.json", file_size: Buffer.byteLength(card) } }), message(d.formatCommand({ pluginId: "chat-ai", routeId: "characterExport", args: ["通用导入卡"] }))];
  const outbound = []; let firstPoll = true, downloads = 0;
  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").at(-1);
    if (method === "getMe") return ok(bot);
    if (method === "getWebhookInfo") return ok({ url: "" });
    if (method === "getUpdates") {
      if (firstPoll) { firstPoll = false; return ok(updates); }
      return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
    if (method === "getFile") return ok({ file_path: "documents/card.json", file_size: Buffer.byteLength(card) });
    if (String(url).includes("/file/bot")) { downloads++; return new Response(card); }
    outbound.push({ method, body: init.body }); return ok({ message_id: 1000 + outbound.length });
  };
  const channel = new TelegramChannel({ config: { botApiToken: "100:fixture-token" }, dispatcher: d, vault, fetchImpl, pacing: false });
  t.after(async () => { await channel.stop(); await p.stop(); vault.close(); });
  await channel.start(); await pause(() => outbound.some(item => item.method === "sendDocument"));
  assert.deepEqual(vault.getSetting("system:admin_users"), ["telegram:7"]);
  assert.equal(downloads, 1); assert.equal(p.services.store.getCharacter("通用导入卡").card.description, JSON.parse(card).description);
  const upload = outbound.find(item => item.method === "sendDocument").body.get("document");
  assert.equal(upload.name, "通用导入卡.json"); assert.equal(JSON.parse(await upload.text()).data.description, JSON.parse(card).description);
  assert.equal(p.services.store.countMessages("telegram:100:private:telegram:7"), 0);
  assert.ok(!outbound.filter(item => item.method === "sendMessage").map(item => item.body).join("\n").includes("registration-value"));
  assert.equal(JSON.parse(outbound[0].body).reply_parameters, undefined, "authentication replies must not quote credentials from the original message");
});

test("Telegram forum topics isolate actual AI history and reply-to-bot triggers mention policy without enabling interjection", async t => {
  const vault = new IdentityVault(), d = new GameHubDispatcher({ vault, env: {} }); const calls = [], sent = [];
  d.registerProvider({ id: "llm", capabilities: ["chat"], createClient: () => ({ complete: async input => { calls.push(input); return { text: "测试回答" }; } }) });
  const p = createChat({ vault, dispatcher: d, config: { model: { defaultProfileId: "main" }, policy: { groupDefault: "mention" } } }); d.registerPlugin(p);
  p.services.store.saveModel({ id: "main", endpoint: "https://api.example.com/v1", model: "fixture", apiKeyEnv: "CHATAI_KEY_TELEGRAM_TEST" });
  t.after(async () => { await p.stop(); vault.close(); });
  const send = async (text, threadId, reply = false) => {
    const value = message(text, { chat: { id: -9, type: "supergroup" }, message_thread_id: threadId,
      entities: reply ? [] : [{ type: "mention", offset: 0, length: 11 }],
      reply_to_message: reply ? { message_id: 1000, from: bot } : undefined });
    const e = shapeUpdate(value, { bot, send: async (target, content) => { sent.push({ target, content }); return { success: true, messageId: String(1000 + sent.length) }; }, readAttachment: async () => Buffer.alloc(0) });
    await d.dispatch(e); await p.services.engine.drain();
  };
  await send("@GameHubBot 话题甲独有内容", 1);
  await send("@GameHubBot 话题乙独有内容", 2);
  await send("这是回复机器人的下一句", 1, true);
  assert.equal(calls.length, 3); assert.equal(sent.length, 3);
  assert.ok(!JSON.stringify(calls[1]).includes("话题甲独有内容"));
  assert.ok(!JSON.stringify(calls[2]).includes("话题乙独有内容"));
  assert.deepEqual(sent.map(row => row.target.threadId), ["1", "2", "1"]);
  assert.ok(p.services.store.countMessages("telegram:100:group:-9:thread:1") > p.services.store.countMessages("telegram:100:group:-9:thread:2"));
});

test("existing ZZZ plugin resolves a Telegram-specific binding without inheriting QQ identity", async t => {
  const vault = new IdentityVault(); t.after(() => vault.close());
  const d = new GameHubDispatcher({ vault, env: {} }), replies = [];
  const role = { uid: "17708598", region: "prod_gf_cn", nickname: "测试角色", level: 60 };
  vault.saveAccountBinding({ unifiedUserId: "telegram:7", platform: "telegram", originalId: "7", providerId: "mihoyo", accountKey: "fixture", gameId: "zzz", cookies: { ck: "cookie_token=fixture" }, roles: [role] });
  const calls = [];
  d.registerProvider({ id: "mihoyo", capabilities: ["game-record", "account"], createClient: () => ({ getDailyNote: async (uid, region) => { calls.push({ uid, region }); return { energy: { progress: { current: 100, max: 240 } } }; } }) });
  let reminder;
  d.registerPlugin({ ...ZZZPluginManifest, services: { store: new ZzzStore(vault), tasks: { configure: input => { reminder = input; return { enabled: true }; } } }, config: {} });
  const text = d.formatCommand({ pluginId: "zzz", routeId: "note" });
  const e = shapeUpdate(message(text), { bot, send: async (_target, value) => { replies.push(String(value)); return { success: true }; }, readAttachment: async () => Buffer.alloc(0) });
  assert.equal((await d.dispatch(e)).status, "HANDLED");
  assert.equal(calls[0].uid, role.uid); assert.ok(replies.join("\n").includes("100"));
  assert.equal(vault.getActiveRole("qq-napcat:7", "zzz"), null);
  d.addAdmin("telegram:7");
  const remind = d.formatCommand({ pluginId: "zzz", routeId: "energyReminder", args: ["开启"] });
  await d.dispatch(shapeUpdate(message(remind, { chat: { id: -9, type: "supergroup" }, message_thread_id: 4 }), { bot, send: async () => ({ success: true }), readAttachment: async () => Buffer.alloc(0) }));
  assert.equal(reminder.target.chatId, "-9"); assert.equal(reminder.target.threadId, "4");
});

test("AI proactive job destinations persist the originating forum topic", async t => {
  const vault = new IdentityVault(), d = new GameHubDispatcher({ vault, adminUsers: ["telegram:7"], env: {} });
  const p = createChat({ vault, dispatcher: d, config: {} }); d.registerPlugin(p);
  t.after(async () => { await p.stop(); vault.close(); });
  const text = d.formatCommand({ pluginId: "chat-ai", routeId: "proactiveSet", args: ["5"] });
  await d.dispatch(shapeUpdate(message(text, { chat: { id: -9, type: "supergroup" }, message_thread_id: 3 }), { bot, send: async () => ({ success: true }), readAttachment: async () => Buffer.alloc(0) }));
  const row = vault.db.prepare("SELECT session_id,target FROM chat_jobs").get();
  assert.equal(row.session_id, "telegram:100:group:-9:thread:3");
  assert.equal(JSON.parse(row.target).threadId, "3"); assert.equal(JSON.parse(row.target).chatId, "-9");
});

test("default module assembly selects Telegram only, with no network during create/stop", async t => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const config = JSON.parse(fs.readFileSync(new URL("../config/modules.json", import.meta.url), "utf8"));
  const vault = new IdentityVault(); t.after(() => vault.close());
  const runtime = await assembleModules({ root, config, vault, env: { TELEGRAM_BOT_API_TOKEN: "100:fixture-token" } });
  t.after(() => runtime.stop());
  assert.deepEqual(runtime.channels.map(channel => channel.id), ["telegram"]);
  assert.equal(runtime.channels[0].status, "created");
  assert.equal(runtime.channels[0].bot, undefined);
  await runtime.stop(); assert.equal(runtime.channels[0].status, "stopped");
});
