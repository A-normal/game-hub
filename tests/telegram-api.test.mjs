import test from "node:test";
import assert from "node:assert/strict";
import { BotApiClient, telegramError } from "../packages/channel/telegram/src/client.mjs";
import { TelegramDelivery, prepareDelivery, sleep } from "../packages/channel/telegram/src/files.mjs";

const token = "100:telegram-test-token";
const ok = result => Response.json({ ok: true, result });
function api(t, fetchImpl, extra = {}) {
  const client = new BotApiClient({ botApiToken: token, fetchImpl, ...extra });
  t.after(() => client.close()); return client;
}
function delivery(t, client, extra = {}) {
  const controller = new AbortController(); t.after(() => controller.abort());
  return new TelegramDelivery({ client, botId: "100", signal: controller.signal, pacing: false, ...extra });
}
const target = { platform: "telegram", botId: "100", userId: "7", chatId: "7", messageId: "9" };

test("Bot API uses explicit POST, private token URL and redirect rejection without exposing the token", async t => {
  let request;
  const client = api(t, async (url, init) => { request = { url, init }; return ok({ id: 100 }); });
  assert.deepEqual(await client.call("getMe"), { id: 100 });
  assert.equal(request.url, `https://api.telegram.org/bot${token}/getMe`);
  assert.equal(request.init.method, "POST"); assert.equal(request.init.redirect, "error");
  assert.equal(JSON.stringify(client), "{}");
  await assert.rejects(client.call("../evil"), { code: "TG_METHOD" });
});

test("API errors discard response descriptions and network details instead of leaking token-bearing URLs", async t => {
  const limited = api(t, async () => Response.json({ ok: false, error_code: 429, description: token, parameters: { retry_after: 3 } }, { status: 429 }));
  await assert.rejects(limited.call("getMe"), error => error.code === "TG_RATE_LIMIT" && error.retryAfter === 3 && !error.message.includes(token));
  let calls = 0;
  const failed = api(t, async () => { calls++; throw new Error(`https://api.telegram.org/bot${token}/sendMessage`); });
  await assert.rejects(failed.call("sendMessage", { text: "message" }), error => error.code === "TG_NETWORK" && error.uncertain && !error.message.includes(token));
  assert.equal(calls, 1);
  const malformed = api(t, async () => new Response(token));
  await assert.rejects(malformed.call("getMe"), error => error.code === "TG_PROTOCOL" && !error.message.includes(token));
});

test("download resolves opaque file IDs internally and enforces actual streamed bytes and metadata limits", async t => {
  const urls = [];
  const client = api(t, async url => { urls.push(url); return urls.length === 1 ? ok({ file_path: "documents/card.txt", file_size: 5 }) : new Response("hello"); });
  assert.equal((await client.readFile("opaque-file", { maxBytes: 5 })).toString(), "hello");
  assert.equal(urls.length, 2); assert.ok(urls[1].includes("/file/bot"));
  const oversized = api(t, async url => url.endsWith("getFile") ? ok({ file_path: "documents/card.txt" }) : new Response("123456"));
  await assert.rejects(oversized.readFile("opaque", { maxBytes: 5 }), { code: "TG_FILE_TOO_LARGE" });
  let requests = 0;
  const metadata = api(t, async () => { requests++; return ok({ file_path: "documents/card.txt", file_size: 100 }); });
  await assert.rejects(metadata.readFile("opaque", { maxBytes: 5 }), { code: "TG_FILE_TOO_LARGE" });
  assert.equal(requests, 1);
});

test("attachments refuse arbitrary URLs, traversal and credentialed or non-HTTPS API endpoints", async t => {
  const client = api(t, async () => ok({ file_path: "../private" }));
  await assert.rejects(client.readFile("https://example.com/private"), { code: "TG_FILE_INVALID" });
  await assert.rejects(client.readFile("opaque"), { code: "TG_FILE_INVALID" });
  for (const apiBaseUrl of ["http://api.example.com", "https://u:p@api.example.com", "https://api.example.com/?secret=x"]) assert.throws(() => new BotApiClient({ botApiToken: token, apiBaseUrl }), { code: "TG_CONFIG" });
  assert.throws(() => new BotApiClient({ botApiToken: token, httpsProxyUrl: "socks5://localhost:1080" }), { code: "TG_CONFIG" });
  const proxied = api(t, async () => ok({ id: 100 }), { httpsProxyUrl: "http://localhost:7890" });
  assert.equal((await proxied.call("getMe")).id, 100);
});

test("text chunks respect UTF-16 boundaries, quote only once and keep every part in the same topic", async t => {
  const calls = [];
  const sender = delivery(t, { call: async (method, params) => { calls.push({ method, params }); return { message_id: calls.length }; } });
  const text = "a".repeat(4095) + "🙂" + "b".repeat(12);
  const result = await sender.send({ ...target, isGroup: true, chatId: "-8", groupId: "-8", threadId: "4" }, text, { quote: true });
  assert.equal(result.success, true); assert.equal(calls.length, 2);
  assert.equal(calls.map(c => c.params.text).join(""), text);
  assert.ok(calls.every(c => c.params.text.length <= 4096 && c.params.message_thread_id === 4));
  assert.equal(calls[0].params.reply_parameters.message_id, 9);
  assert.equal(calls[1].params.reply_parameters, undefined);
  assert.deepEqual(result.messageIds, ["1", "2"]);
});

test("files and base64 images use multipart Buffer uploads; all validation precedes the first delivery", async t => {
  const calls = [];
  const sender = delivery(t, { call: async (method, params, options) => { calls.push({ method, params, form: options.form }); return { message_id: calls.length }; } });
  await sender.send(target, { text: "file follows", files: [{ name: "card.json", data: Buffer.from("{}") }] });
  assert.equal(calls[1].method, "sendDocument"); assert.equal(calls[1].form.get("document").name, "card.json");
  assert.equal(await calls[1].form.get("document").text(), "{}");
  await sender.send(target, { segments: [{ type: "image", file: "base64://" + Buffer.from("image").toString("base64") }] });
  assert.equal(calls[2].method, "sendPhoto");
  const count = calls.length;
  await assert.rejects(sender.send(target, { text: "must not send", files: [{ name: "../secret", data: Buffer.from("x") }] }));
  assert.equal(calls.length, count);
  assert.throws(() => prepareDelivery({ segments: [{ type: "image", file: "/local/file.png" }] }));
});

test("429 is retried once after retry_after; uncertain network failures are not replayed", async t => {
  let calls = 0; const waits = [];
  const sender = delivery(t, { call: async () => { if (++calls === 1) throw telegramError("TG_RATE_LIMIT", "rate", { retryAfter: 2 }); return { message_id: 1 }; } }, { sleepImpl: async ms => { waits.push(ms); } });
  assert.equal((await sender.send(target, "message")).success, true);
  assert.equal(calls, 2); assert.deepEqual(waits, [2000]);
  calls = 0;
  const uncertain = delivery(t, { call: async () => { calls++; throw telegramError("TG_NETWORK", "safe error", { uncertain: true }); } });
  const result = await uncertain.send(target, "message");
  assert.equal(calls, 1); assert.equal(result.success, false); assert.equal(result.uncertain, true);
});

test("partial delivery records completed parts and per-chat queues preserve request order", async t => {
  const calls = [];
  const sender = delivery(t, { call: async (_method, params) => { calls.push(params.text); if (calls.length === 2) throw telegramError("TG_API", "rejected"); return { message_id: calls.length }; } });
  const results = await Promise.all([sender.send(target, "a".repeat(4097)), sender.send(target, "next")]);
  assert.equal(results[0].partial, true); assert.equal(results[0].partsDelivered, 1);
  assert.deepEqual(results[0].messageIds, ["1"]); assert.equal(calls[2], "next"); assert.equal(results[1].success, true);
  await assert.rejects(sender.send({ ...target, botId: "other" }, "wrong bot"));
});

test("lifecycle cancellation interrupts waits and prevents calls after client close", async t => {
  const controller = new AbortController();
  const waiting = sleep(60000, controller.signal); controller.abort();
  await assert.rejects(waiting, { code: "TG_STOPPED" });
  const client = api(t, async () => ok(true)); await client.close();
  await assert.rejects(client.call("getMe"), { code: "TG_STOPPED" });
});

test("client close also aborts an in-flight request without a caller signal", async t => {
  const client = api(t, async (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })));
  const pending = client.call("getMe"); const check = assert.rejects(pending, error => error.code === "TG_STOPPED" && error.uncertain === true);
  await client.close(); await check;
});

test("per-group pacing also applies across different forum topics", async t => {
  let clock = 10000; const waits = [];
  const sender = delivery(t, { call: async () => ({ message_id: 1 }) }, { pacing: true, now: () => clock, sleepImpl: async ms => { waits.push(ms); clock += ms; } });
  await sender.send({ ...target, chatId: "-9", groupId: "-9", isGroup: true, threadId: "1" }, "one");
  await sender.send({ ...target, chatId: "-9", groupId: "-9", isGroup: true, threadId: "2" }, "two");
  assert.ok(waits.some(ms => ms >= 3000));
});
