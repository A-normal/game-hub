import test from "node:test";
import assert from "node:assert/strict";
import { IdentityVault, InboundShaper, GameHubDispatcher } from "../packages/core/src/index.mjs";
import { ZZZPluginManifest } from "../packages/plugin/zzz/src/manifest.mjs";
import { ZzzStore } from "../packages/plugin/zzz/src/storage.mjs";

const owner = "mock:1";
const role = { uid: "17708598", region: "prod_gf_cn", nickname: "哲", level: 60 };

function setup(t, { client = {}, services = {}, config = {} } = {}) {
  const vault = new IdentityVault();
  t.after(() => vault.close());
  vault.saveAccountBinding({
    unifiedUserId: owner, platform: "mock", originalId: "1",
    providerId: "mihoyo", accountKey: "100", gameId: "zzz",
    cookies: { ck: "ltuid=100; ltoken=secret_ltoken; cookie_token=secret_cookie" },
    roles: [role]
  });
  const store = new ZzzStore(vault, services.now);
  const dispatcher = new GameHubDispatcher({ vault });
  dispatcher.registerProvider({
    id: "mihoyo",
    capabilities: ["game-record", "account", "sign", "gacha"],
    issueDeviceFingerprint:async deviceId=>({device_id:deviceId,device_fp:"123456789abcd",device_fp_source:"official-web"}),
    createClient: () => client
  });
  dispatcher.registerPlugin({ ...ZZZPluginManifest, config, services: { store, ...services } });
  const replies = [];
  const event = (text, options = {}) => ({
    cleanText: text, unifiedUserId: owner, platform: "mock",
    sender: { id: "1", role: "member" },
    reply: async value => { replies.push(String(value)); return { success: true }; },
    ...options
  });
  return { vault, store, dispatcher, replies, event, run: (text, options) => dispatcher.dispatch(event(text, options)) };
}

test("InboundShaper: extracts image segments, CQ codes, replies and sanitizes log text", () => {
  const rawWithSegments = {
    post_type: "message", user_id: 12345,
    message: [
      { type: "text", data: { text: "看图" } },
      { type: "image", data: { url: "https://example.com/seg.png", file: "seg.png" } },
      { type: "reply", data: { id: "98765" } }
    ]
  };
  const shaped1 = InboundShaper.shape(rawWithSegments);
  assert.equal(shaped1.images?.length, 1);
  assert.equal(shaped1.images[0].url, "https://example.com/seg.png");
  assert.equal(shaped1.replyMessage?.id, "98765");

  const rawWithCq = {
    post_type: "message", user_id: 12345,
    raw_message: "[CQ:reply,id=55555][CQ:image,file=test.png,url=https://example.com/cq.png] *换装 艾莲"
  };
  const shaped2 = InboundShaper.shape(rawWithCq);
  assert.equal(shaped2.images?.length, 1);
  assert.equal(shaped2.images[0].url, "https://example.com/cq.png");
  assert.equal(shaped2.replyMessage?.id, "55555");

  const dirtyLog = "User sent Cookie: ltuid=123; ltoken=secret_token; cookie_token=auth_cookie; authkey=secret_key #gh 认证 my_admin_token";
  const scrubbed = InboundShaper.sanitizeLogText(dirtyLog);
  assert.ok(!scrubbed.includes("secret_token"));
  assert.ok(!scrubbed.includes("auth_cookie"));
  assert.ok(!scrubbed.includes("secret_key"));
  assert.ok(!scrubbed.includes("my_admin_token"));
  assert.ok(scrubbed.includes("ltoken=***"));
  assert.ok(scrubbed.includes("cookie_token=***"));
  assert.ok(scrubbed.includes("authkey=***"));
});

test("IdentityVault: transparent AES-256-GCM encryption, decryption and multi-user active role isolation", t => {
  const vault = new IdentityVault();
  t.after(() => vault.close());

  vault.saveCredential("test-p", "acc-1", { ck: "stoken=test_secret_value;" }, { device_id: "dev-1" });
  const rawRow = vault.db.prepare("SELECT cookies_json FROM community_credentials WHERE provider_id = ? AND account_key = ?").get("test-p", "acc-1");
  assert.ok(rawRow.cookies_json.startsWith("enc:v1:"), "database row must be encrypted with enc:v1: prefix");
  assert.ok(!rawRow.cookies_json.includes("test_secret_value"), "raw database must not contain plaintext secret");

  vault.bindUser("user:1", "mock", "1", "test-p", "acc-1");
  const cred = vault.getUserCredential("user:1", "test-p", "acc-1");
  assert.equal(cred.cookies.ck, "stoken=test_secret_value;", "transparently decrypted in memory");

  vault.db.prepare("INSERT INTO community_credentials (provider_id, account_key, cookies_json, device_meta, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(provider_id, account_key) DO UPDATE SET cookies_json=excluded.cookies_json").run("test-p", "acc-legacy", '{"ck":"legacy_plain"}', "{}");
  vault.bindUser("user:1", "mock", "1", "test-p", "acc-legacy");
  const legacyCred = vault.getUserCredential("user:1", "test-p", "acc-legacy");
  assert.equal(legacyCred.cookies.ck, "legacy_plain", "backward compatibility with unencrypted rows");

  vault.saveAccountBinding({
    unifiedUserId: "user:A", platform: "mock", originalId: "A",
    providerId: "shared-p", accountKey: "shared-acc", gameId: "zzz",
    cookies: { ck: "shared_cookie" },
    roles: [
      { uid: "1001", region: "prod_gf_cn", nickname: "角色1", level: 50 },
      { uid: "1002", region: "prod_gf_cn", nickname: "角色2", level: 60 }
    ]
  });
  vault.bindUser("user:B", "mock", "B", "shared-p", "shared-acc");

  vault.setActiveRole("user:A", "zzz", "1001");
  vault.setActiveRole("user:B", "zzz", "1002");

  assert.equal(vault.getActiveRole("user:A", "zzz").uid, "1001");
  assert.equal(vault.getActiveRole("user:B", "zzz").uid, "1002");

  const rolesA = vault.getUserRoles("user:A", "zzz");
  assert.equal(rolesA[0].uid, "1001");
  assert.equal(rolesA[0].is_active, 1);

  const rolesB = vault.getUserRoles("user:B", "zzz");
  assert.equal(rolesB[0].uid, "1002");
  assert.equal(rolesB[0].is_active, 1);
});

test("business image routes are unavailable", async t => {
  const h = setup(t);
  for (const token of ["换装 艾莲", "原图 艾莲", "自定义面板图 艾莲"]) {
    const result = await h.run("*" + token);
    assert.equal(result.status, "HANDLED");
    assert.match(h.replies.at(-1), /未识别/);
    assert.ok(!h.replies.at(-1).includes("CQ:image"));
  }
});

test("Daily Note: complete ZZZ Takumi fields parsing and formatting", async t => {
  const client = {
    getDailyNote: async (uid, region) => ({
      energy: { progress: { current: 180, max: 240 }, restore: 3600 },
      vitality: { current: 300, max: 400 },
      vhs_sale: { sale_state: "SaleStateDoing" },
      card_sign: "CardSignDone",
      bounty_commission: { num: 2, total: 3 },
      survey_points: { num: 4, total: 5 }
    })
  };
  const h = setup(t, { client });

  await h.run("*便签");
  const reply = h.replies.at(-1);

  assert.ok(reply.includes("实时电量: 180 / 240"));
  assert.ok(reply.includes("预计回满:"));
  assert.ok(reply.includes("每日活跃: 300 / 400"));
  assert.ok(reply.includes("录像店经营: 营业中"));
  assert.ok(reply.includes("报刊亭刮卡: 今日已刮奖"));
  assert.ok(reply.includes("恶名狩猎: 剩余 2 / 3 次"));
  assert.ok(reply.includes("空洞调查: 4 / 5 点"));
});

test("Maintenance & settings: default device, panel cooldown, and cache cleaning", async t => {
  const h = setup(t);

  await h.run("*默认设备");
  assert.ok(h.replies.at(-1).includes("设备配置"));
  assert.ok(h.replies.at(-1).includes("设备指纹:"));
  const generated = h.vault.getActiveRole(owner, "zzz").device;
  assert.ok(generated.device_id && generated.device_fp, "default device must persist id and fingerprint");

  // 只补 device_id 时必须保留已有指纹，不能被写成 undefined
  await h.run("*绑定设备 11112222");
  assert.match(h.replies.at(-1), /设备ID: 11112222/);
  assert.equal(h.vault.getActiveRole(owner, "zzz").device.device_fp, generated.device_fp);
  await h.run("*绑定设备 33334444 0123456789abc");
  assert.match(h.replies.at(-1), /0123456789abc/);
  assert.equal(h.vault.getActiveRole(owner, "zzz").device.device_id, "33334444");

  await h.run("*面板冷却 30");
  assert.ok(h.replies.at(-1).includes("设置为 30 秒"));
  await h.run("*面板冷却");
  assert.ok(h.replies.at(-1).includes("当前设置：30 秒"));

  h.store.put(owner, role, "panel", "mihoyo", { test: true });
  assert.ok(h.store.get(owner, role, "panel", "mihoyo"));

  await h.run("*清理缓存 面板");
  assert.ok(h.replies.at(-1).includes("已成功清除「面板」缓存记录"));
  assert.equal(h.store.get(owner, role, "panel", "mihoyo"), null);
});
