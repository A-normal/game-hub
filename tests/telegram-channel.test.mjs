import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IdentityVault, GameHubDispatcher, InboundShaper } from "../packages/core/src/index.mjs";
import { TelegramChannel, shapeUpdate } from "../packages/channel/telegram/src/index.mjs";
import { telegramError } from "../packages/channel/telegram/src/client.mjs";
import { sessionKeyOf, draftKeyOf, isSensitiveText } from "../packages/plugin/chat-ai/src/session.mjs";

const bot = { id: 100, is_bot: true, username: "GameHubBot", can_read_all_group_messages: true };
function update(id = 1, extra = {}) {
  return { update_id: id, message: { message_id: id + 1, date: 1700000000, from: { id: 7, first_name: "Test" }, chat: { id: 7, type: "private" }, text: "hello", ...extra } };
}
const shape = (value, extra = {}) => shapeUpdate(value, { bot, send: async () => ({ success: true }), readAttachment: async () => Buffer.from("content"), ...extra });
async function until(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.fail("bounded channel condition did not complete");
}
class FakeClient {
  calls = []; plan; closed = 0; tokenBotId = "100"; sent = 0;
  constructor(plan = []) { this.plan = [...plan]; }
  async call(method, params, { signal } = {}) {
    this.calls.push({ method, params });
    if (method === "getMe") return bot;
    if (method === "getWebhookInfo") return { url: "" };
    if (method.startsWith("send")) return { message_id: ++this.sent };
    if (this.plan.length) { const value = this.plan.shift(); if (value instanceof Error) throw value; return value; }
    return new Promise((resolve, reject) => {
      const abort = () => reject(telegramError("TG_STOPPED", "stopped"));
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
  }
  async readFile() { return Buffer.from("content"); }
  async close() { this.closed++; }
}
function fixture(t, { client = new FakeClient(), vault, dispatcher, ...extra } = {}) {
  const owned = !vault; vault ??= new IdentityVault(); const events = [];
  dispatcher ??= { dispatch: async event => { events.push(event); }, formatCommand: () => "动态系统调用标记认证 <令牌>" };
  const channel = new TelegramChannel({ config: {}, client, vault, dispatcher, pacing: false, ...extra });
  t.after(async () => { await channel.stop(); if (owned) vault.close(); });
  return { channel, client, vault, events, dispatcher };
}

test("normalization handles supergroups, UTF-16 mention offsets, references and lazy file attachments", async () => {
  let reads = 0, destination;
  const text = "🙂 @GameHubBot hello";
  const event = shape(update(0, { text, chat: { id: -9, type: "supergroup" }, message_thread_id: 4,
    entities: [{ type: "mention", offset: 3, length: 11 }],
    reply_to_message: { message_id: 8, text: "quoted", from: bot },
    document: { file_id: "opaque", file_name: "card.txt", file_size: 7 }
  }), { readAttachment: async () => { reads++; return Buffer.from("content"); }, send: async target => { destination = target; return { success: true }; } });
  assert.equal(event.isGroup, true); assert.equal(event.groupId, "-9"); assert.equal(event.threadId, "4");
  assert.equal(event.unifiedUserId, "telegram:7"); assert.equal(event.mentionedBot, true); assert.equal(event.replyToBot, true);
  assert.equal(event.eventId, "telegram:100:0"); assert.equal(event.replyMessage.id, "8");
  assert.equal(reads, 0); assert.equal((await event.attachments[0].readBytes({ maxBytes: 10 })).toString(), "content");
  assert.equal(reads, 1); await event.reply("reply"); assert.equal(destination.chatId, "-9"); assert.equal(destination.threadId, "4");
});

test("addressed bot commands retain dynamic namespace text while commands for other bots and anonymous senders are ignored", () => {
  const command = "/gh@GameHubBot 认证 registration";
  const event = shape(update(1, { text: command, entities: [{ type: "bot_command", offset: 0, length: 14 }] }));
  assert.equal(event.cleanText, "/gh 认证 registration"); assert.equal(event.commandHint, true);
  assert.equal(shape(update(1, { text: "/gh@OtherBot 认证 secret", entities: [{ type: "bot_command", offset: 0, length: 12 }] })), null);
  assert.equal(shape(update(1, { from: { id: 7, is_bot: true } })), null);
  assert.equal(shape(update(1, { sender_chat: { id: -9 } })), null);
  assert.equal(shape(update(1, { from: undefined })), null);
  assert.equal(shape(update(1, { chat: { id: -9, type: "private" } })), null);
  assert.equal(shape({ update_id: 1, edited_message: update().message }), null);
  const structured = '{"command":"/gh@OtherBot"}';
  const json = shape(update(2, { text: structured, entities: [{ type: "bot_command", offset: structured.indexOf("/"), length: 12 }] }));
  assert.equal(json.cleanText, structured); assert.equal(json.commandHint, false);
});

test("photo references and quoted images never contain a token-bearing download URL", () => {
  const event = shape(update(1, { text: undefined, caption: "photo", photo: [{ file_id: "small" }, { file_id: "large", file_size: 100 }], reply_to_message: { message_id: 3, photo: [{ file_id: "quoted" }] } }));
  assert.equal(event.attachments[0].id, "large"); assert.equal(event.cleanText, "photo");
  assert.equal(event.images[0].file, "telegram-file:large"); assert.equal(event.replyMessage.images[0].file, "telegram-file:quoted");
  assert.ok(!JSON.stringify(event).includes("/bot"));
});

test("polling persists the claim before dispatch, skips duplicates and closes requests on stop", async t => {
  const f = fixture(t, { client: new FakeClient([[update(4), update(4), update(5)]]) });
  let claims = [];
  f.dispatcher.dispatch = async event => { claims.push(f.vault.getSetting("channel:telegram:100:cursor").nextUpdateId); f.events.push(event); };
  assert.equal(f.client.calls.length, 0);
  await Promise.all([f.channel.start(), f.channel.start()]);
  await until(() => f.events.length === 2);
  assert.deepEqual(claims, [5, 6]); assert.equal(f.client.calls.filter(c => c.method === "getMe").length, 1);
  await f.channel.stop(); assert.equal(f.channel.status, "stopped"); assert.ok(f.client.closed > 0);
  assert.equal((await f.channel.send({ userId: "7" }, "stopped")).success, false);
});

test("cursor survives a real database reopen and prevents repeated command execution", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gamehub-telegram-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "vault.db"); let vault = new IdentityVault(file);
  const a = fixture(t, { vault, client: new FakeClient([[update(8)]]) });
  await a.channel.start(); await until(() => a.events.length === 1); await a.channel.stop(); vault.close();
  vault = new IdentityVault(file); const b = fixture(t, { vault, client: new FakeClient([[update(8), update(9)]]) });
  try {
    await b.channel.start(); await until(() => b.events.length === 1);
    assert.equal(b.events[0].eventId, "telegram:100:9");
    assert.equal(b.client.calls.find(c => c.method === "getUpdates").params.offset, 9);
  } finally { await b.channel.stop(); vault.close(); }
});

test("cursor write failure stops reception before dispatch, and network/429 failures use bounded backoff", async t => {
  const f = fixture(t, { client: new FakeClient([[update(1)]]) });
  f.vault.setSetting = () => { throw new Error("private-database-error"); };
  await f.channel.start(); await until(() => f.channel.status === "failed");
  assert.equal(f.channel.failureCode, "TG_CURSOR_STORE"); assert.equal(f.events.length, 0);
  const waits = [], g = fixture(t, { client: new FakeClient([telegramError("TG_NETWORK", "network"), telegramError("TG_RATE_LIMIT", "rate", { retryAfter: 2 }), [update(2)]]), sleepImpl: async ms => { waits.push(ms); } });
  await g.channel.start(); await until(() => g.events.length === 1);
  assert.deepEqual(waits, [1000, 2000]);
});

test("active webhook and wrong bot identity fail closed without mutating Telegram settings", async t => {
  const client = new FakeClient();
  const original = client.call.bind(client);
  client.call = (method, ...rest) => method === "getWebhookInfo" ? Promise.resolve({ url: "https://example.com/existing" }) : original(method, ...rest);
  const f = fixture(t, { client });
  await assert.rejects(f.channel.start(), { code: "TG_WEBHOOK_CONFIGURED" });
  assert.ok(!client.calls.some(c => c.method === "deleteWebhook"));
  const wrong = new FakeClient(); wrong.tokenBotId = "999";
  const g = fixture(t, { client: wrong }); await assert.rejects(g.channel.start(), { code: "TG_IDENTITY" });
});

test("Telegram authentication delegates to the existing core route and never authenticates a group sender", async t => {
  const vault = new IdentityVault(); t.after(() => vault.close());
  const dispatcher = new GameHubDispatcher({ vault, env: { GAMEHUB_ADMIN_REGISTRATION_TOKEN: "system-registration" } });
  const text = dispatcher.formatCommand({ pluginId: "system", routeId: "auth", args: ["system-registration"] });
  const client = new FakeClient([[update(1, { text, chat: { id: -9, type: "supergroup" } }), update(2, { text })]]);
  const f = fixture(t, { vault, dispatcher, client }); await f.channel.start();
  await until(() => client.sent === 2);
  assert.deepEqual(vault.getSetting("system:admin_users"), ["telegram:7"]);
  assert.equal(dispatcher.isAdmin({ platform: "qq-napcat", unifiedUserId: "qq-napcat:7", sender: { id: "7" } }), false);
});

test("topic identities preserve legacy sessions, isolate AI drafts and scrub Telegram credentials", () => {
  const event = shape(update(1, { chat: { id: -9, type: "supergroup" } }));
  assert.equal(sessionKeyOf(event), "telegram:100:group:-9");
  assert.notEqual(sessionKeyOf({ ...event, threadId: "1" }), sessionKeyOf({ ...event, threadId: "2" }));
  assert.notEqual(draftKeyOf({ ...event, threadId: "1" }), draftKeyOf({ ...event, threadId: "2" }));
  const secret = "123456789:abcdefghijklmnopqrstuv_secret";
  assert.equal(isSensitiveText(secret), true);
  const scrubbed = InboundShaper.sanitizeLogText(`https://api.telegram.org/file/bot${secret}/file.png TELEGRAM_BOT_API_TOKEN=${secret} https://user:proxy-secret@localhost:7890`);
  assert.ok(!scrubbed.includes(secret)); assert.ok(!scrubbed.includes("proxy-secret"));
});

test("fatal polling conflicts do not loop and claimed handler failures are not dispatched twice", async t => {
  const f = fixture(t, { client: new FakeClient([telegramError("TG_CONFLICT", "another poller")]) });
  await f.channel.start(); await until(() => f.channel.status === "failed");
  assert.equal(f.client.calls.filter(c => c.method === "getUpdates").length, 1);
  const g = fixture(t, { client: new FakeClient([[update(4)], [update(4)]]) }); let dispatched = 0;
  g.dispatcher.dispatch = async () => { dispatched++; throw new Error("handler failed"); };
  await g.channel.start(); await until(() => g.client.calls.filter(c => c.method === "getUpdates").length === 3);
  assert.equal(dispatched, 1); assert.equal(g.vault.getSetting("channel:telegram:100:cursor").nextUpdateId, 5);
});

test("a week-old offset resets safely for Telegram randomized update identifiers", async t => {
  const f = fixture(t, { client: new FakeClient([[update(2)]]), now: () => 8 * 24 * 60 * 60 * 1000 });
  f.vault.setSetting("channel:telegram:100:cursor", { nextUpdateId: 1000, lastUpdateAt: 1 });
  await f.channel.start(); await until(() => f.events.length === 1);
  assert.equal(f.client.calls.find(c => c.method === "getUpdates").params.offset, 0);
  assert.equal(f.vault.getSetting("channel:telegram:100:cursor").nextUpdateId, 3);
});

test("stopping during startup cancels getMe and leaves no active polling loop", async t => {
  const client = new FakeClient();
  client.call = (_method, _params, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(telegramError("TG_STOPPED", "stopped")), { once: true });
  });
  const f = fixture(t, { client }); const pending = f.channel.start();
  const stopped = f.channel.stop(); await assert.rejects(pending, { code: "TG_STOPPED" }); await stopped;
  assert.equal(f.channel.status, "stopped"); assert.ok(client.closed > 0);
});

test("attachment limits are checked before download and stopped closures cannot read", async t => {
  const f = fixture(t); let reads = 0;
  f.client.readFile = async () => { reads++; return Buffer.from("x"); };
  await f.channel.start();
  await assert.rejects(f.channel.readAttachment({ id: "opaque", size: 10 }, { maxBytes: 5 }), { code: "TG_FILE_TOO_LARGE" });
  assert.equal(reads, 0);
  await f.channel.stop();
  await assert.rejects(f.channel.readAttachment({ id: "opaque" }), { code: "TG_STOPPED" });
});
