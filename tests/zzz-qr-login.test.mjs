import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { IdentityVault, InboundShaper, GameHubDispatcher, logger } from "../packages/core/src/index.mjs";
import { MihoyoCommunityProvider } from "../packages/provider/mihoyo/src/index.mjs";
import { createLoginQrHandler } from "../packages/plugin/zzz/src/handlers/login-qr.mjs";
import { ZZZPluginManifest } from "../packages/plugin/zzz/src/manifest.mjs";

const ACCOUNT = "10001";
const USER = "qq-napcat:12345";
const ROLES = [
  { game_uid: "10009999", region: "prod_gf_cn", nickname: "铃", level: 25 },
  { game_uid: "17708598", region: "prod_gf_cn", nickname: "哲", level: 60 }
];
const CONFIRMED = {
  status: "Confirmed",
  user_info: { aid: ACCOUNT, mid: "account-mid" },
  tokens: [{ name: "stoken", token: "v2_real_stoken==" }, { name: "ltoken", token: "real_ltoken==" }]
};

function api(data, { cookies = [], retcode = 0, status = 200 } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify({ retcode, data }), { status, headers });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(t, options = {}) {
  const vault = new IdentityVault();
  t.after(() => vault.close());
  const replies = [];
  const requests = [];
  const logs = [];
  t.mock.method(logger, "info", (...args) => logs.push(args.join(" ")));
  t.mock.method(logger, "warn", (...args) => logs.push(args.join(" ")));
  let clock = 0;
  let pollCount = 0;
  const baseFetch = async (url, init) => {
    if (url.includes("createQRLogin")) return api({ url: "https://user.mihoyo.com/qr?ticket=test-ticket", ticket: "test-ticket" });
    if (url.includes("queryQRLoginStatus")) {
      const statuses = options.statuses || ["Scanned", "Confirmed"];
      const status = statuses[Math.min(pollCount++, statuses.length - 1)];
      return api(status === "Confirmed" ? (options.confirmed || CONFIRMED) : { status }, options.pollResponse);
    }
    if (url.includes("getCookieAccountInfoBySToken")) return api({ cookie_token: "real_cookie_token==", uid: ACCOUNT });
    if (url.includes("getUserGameRolesByCookie")) return api({ list: options.roles || ROLES });
    if (url.includes("/api/zzz/note")) return api({ energy: { current: 123, max: 240 } });
    throw new Error("Unexpected URL in test: " + url);
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    return options.fetch ? options.fetch(String(url), init, baseFetch) : baseFetch(String(url), init);
  };
  const rawHandler = createLoginQrHandler({
    fetchImpl,
    now: () => clock,
    sleep: async (ms, signal) => {
      signal.throwIfAborted();
      clock += ms;
    },
    // PNG 编码已有独立测试；登录测试只替换耗时编码，保持真实协议状态和身份库。
    encodeQr: async () => "base64://test-png",
    ...options.handler
  });
  const commandDispatcher = new GameHubDispatcher({vault});
  commandDispatcher.registerPlugin(ZZZPluginManifest);
  commandDispatcher.setNamespace("zzz", {prefix:"%",aliases:["zzz"]});
  const handler = ctx => rawHandler({commands:{format:spec=>commandDispatcher.formatCommand({pluginId:"zzz",...spec})},...ctx});
  const event = (text, userId = 12345) => InboundShaper.shape({
    post_type: "message", message_type: "private", user_id: userId,
    message_id: crypto.randomUUID(), raw_message: text
  }, { sendFunction: async (target, message) => {
    replies.push(String(message));
    return options.reply ? options.reply(target, message) : { success: true, messageId: "reply-1" };
  } });
  const run = (text = "%扫码", userId = 12345) => handler({
    event: event(text, userId),
    matchedToken: text.includes("终止") ? "扫码终止" : "扫码",
    args: [], vault
  });
  const assertEmpty = () => {
    for (const table of ["chat_users", "community_credentials", "user_community_bindings", "game_roles"]) {
      assert.equal(vault.db.prepare("SELECT COUNT(*) AS count FROM " + table).get().count, 0, table + " must remain empty");
    }
    assert.equal(vault.foreignKeyCheck().length, 0);
    assert.ok(!replies.some(reply => reply.includes("登录成功") || reply.includes("绑定成功")));
  };
  return { vault, replies, requests, logs, handler, fetchImpl, event, run, assertEmpty };
}

test("ZZZ QR login: real event identity, credentials, transactions and lifecycle", async t => {
  await t.test("shaped event -> dispatcher -> confirmed login -> Vault -> authenticated follow-up", async t => {
    const h = harness(t);
    const provider = new MihoyoCommunityProvider();
    const dispatcher = new GameHubDispatcher({ vault: h.vault });
    dispatcher.registerProvider(provider);
    dispatcher.registerPlugin({ ...ZZZPluginManifest, routes: ZZZPluginManifest.routes.map(route =>
      route.id === "loginQr" ? { ...route, action: h.handler } : route) });
    dispatcher.setNamespace("zzz", { prefix: "%", aliases: ["zzz", "绝区零"] });
    const event = h.event("%扫码");
    assert.equal(event.originalId, undefined, "must reproduce the actual gateway envelope");
    await dispatcher.dispatch(event);
    const user = h.vault.db.prepare("SELECT * FROM chat_users").get();
    assert.equal(user.original_id, "12345");
    assert.equal(user.platform, "qq-napcat");
    assert.equal(user.unified_user_id, USER);
    const role = h.vault.getActiveRole(USER, "zzz");
    assert.equal(role.uid, "17708598", "highest level role must be selected");
    assert.equal(h.vault.getUserRoles(USER, "zzz").length, 2);
    assert.equal(h.vault.getActiveRole("qq-napcat:99999", "zzz"), null);
    assert.ok(h.replies.at(-1).includes("扫码绑定成功"));
    assert.equal(h.replies.filter(reply => reply.includes("二维码已扫描")).length, 1);
    const cookie = role.cookies.ck;
    assert.ok(cookie.includes("stoken=v2_real_stoken=="));
    assert.ok(cookie.includes("ltoken=real_ltoken=="), "stoken must not impersonate ltoken");
    assert.ok(cookie.includes("cookie_token=real_cookie_token=="));
    const exchange = h.requests.find(request => request.url.includes("getCookieAccountInfoBySToken"));
    assert.equal(new URL(exchange.url).searchParams.get("stoken"), "v2_real_stoken==");
    assert.equal(exchange.init.headers["x-rpc-device_id"], role.device.device_id);
    assert.ok(exchange.init.headers.DS);
    assert.ok(h.requests[0].url.includes("/app/"), "keep the proven app login mode");
    assert.ok(h.requests.filter(request => request.url.includes("QRLogin")).every(request =>
      request.init.headers["x-rpc-device_id"] === role.device.device_id));
    t.mock.method(globalThis, "fetch", h.fetchImpl);
    await dispatcher.dispatch(h.event("%便签"));
    const noteRequest = h.requests.find(request => request.url.includes("/api/zzz/note"));
    assert.equal(noteRequest.init.headers.Cookie, cookie, "provider must receive the saved credentials");
    assert.ok(h.replies.at(-1).includes("实时电量: 123 / 240"));
    assert.equal(h.vault.foreignKeyCheck().length, 0);
    for (const secret of ["v2_real_stoken", "real_ltoken", "real_cookie_token", "test-ticket"]) {
      assert.ok(!h.logs.join("\n").includes(secret), "logs must not contain " + secret);
    }
  });

  await t.test("web mode preserves v2 Set-Cookie values including equals signs", async t => {
    const h = harness(t, {
      confirmed: { status: "Confirmed" },
      pollResponse: { cookies: [
        "account_id_v2=10001; Path=/; HttpOnly",
        "ltuid_v2=10001; Path=/",
        "account_mid_v2=mid; Path=/",
        "ltoken_v2=distinct_ltoken==; Expires=Wed, 28 Oct 2026 00:00:00 GMT; Path=/",
        "cookie_token_v2=v2_cookie==; Path=/"
      ] }
    });
    await h.run("%扫码 web");
    assert.ok(h.requests[0].url.includes("/web/"));
    assert.equal(h.requests[0].init.headers["x-rpc-app_id"], "bll8iq97cem8");
    assert.ok(h.vault.getActiveRole(USER, "zzz").cookies.ck.includes("cookie_token_v2=v2_cookie=="));
    assert.ok(h.vault.getActiveRole(USER, "zzz").cookies.ck.includes("ltoken_v2=distinct_ltoken=="));
    assert.ok(!h.requests.some(request => request.url.includes("getCookieAccountInfoBySToken")));
  });

  await t.test("combined Set-Cookie fallback does not split Expires commas or truncate tokens", async t => {
    const h = harness(t, { fetch: (url, init, base) => {
      if (!url.includes("queryQRLoginStatus")) return base(url, init);
      return {
        ok: true,
        headers: { get: () => "ltuid=10001; Expires=Wed, 28 Oct 2026 00:00:00 GMT, cookie_token=combined==; Path=/, ltoken=separate==; HttpOnly" },
        json: async () => ({ retcode: 0, data: { status: "Confirmed" } })
      };
    } });
    await h.run();
    const cookie = h.vault.getActiveRole(USER, "zzz").cookies.ck;
    assert.ok(cookie.includes("cookie_token=combined=="));
    assert.ok(cookie.includes("ltoken=separate=="));
    assert.ok(!cookie.includes("Expires="));
  });

  await t.test("numeric stoken type is supported without manufacturing an ltoken", async t => {
    const h = harness(t, { confirmed: { ...CONFIRMED, tokens: [{ token_type: 1, token: "typed_stoken==" }] } });
    await h.run();
    const cookie = h.vault.getActiveRole(USER, "zzz").cookies.ck;
    assert.ok(cookie.includes("stoken=typed_stoken=="));
    assert.ok(!cookie.includes("ltoken="));
  });

  await t.test("valid account without ZZZ roles is saved with an explicit no-role result", async t => {
    const h = harness(t, { roles: [] });
    await h.run();
    assert.equal(h.vault.db.prepare("SELECT COUNT(*) AS count FROM user_community_bindings").get().count, 1);
    assert.equal(h.vault.getActiveRole(USER, "zzz"), null);
    assert.ok(h.replies.at(-1).includes("未绑定绝区零游戏角色"));
  });

  for (const [name, fetchOverride, expected] of [
    ["role API rejects credentials", (url, init, base) => url.includes("getUserGameRolesByCookie") ? api({}, { retcode: -100 }) : base(url, init), "retcode: -100"],
    ["role API HTTP failure", (url, init, base) => url.includes("getUserGameRolesByCookie") ? api({}, { status: 503 }) : base(url, init), "HTTP 503"],
    ["role list missing", (url, init, base) => url.includes("getUserGameRolesByCookie") ? api({}) : base(url, init), "列表格式异常"],
    ["malformed role", (url, init, base) => url.includes("getUserGameRolesByCookie") ? api({ list: [{ nickname: "missing UID" }] }) : base(url, init), "角色数据不完整"],
    ["cookie exchange fails", (url, init, base) => url.includes("getCookieAccountInfoBySToken") ? api({}, { retcode: -101 }) : base(url, init), "retcode: -101"],
    ["cookie exchange returns no token", (url, init, base) => url.includes("getCookieAccountInfoBySToken") ? api({}) : base(url, init), "未返回 cookie_token"],
    ["cookie exchange returns a different account", (url, init, base) => url.includes("getCookieAccountInfoBySToken") ? api({ cookie_token: "wrong", uid: "20002" }) : base(url, init), "ID 不一致"],
    ["create API error", (url, init, base) => url.includes("createQRLogin") ? api({}, { retcode: -1 }) : base(url, init), "创建二维码失败"],
    ["create missing ticket", (url, init, base) => url.includes("createQRLogin") ? api({ url: "https://user.mihoyo.com/qr" }) : base(url, init), "票据"],
    ["poll API error is not mislabeled expiry", (url, init, base) => url.includes("queryQRLoginStatus") ? api({}, { retcode: -200 }) : base(url, init), "retcode: -200"],
    ["invalid JSON", (url, init, base) => url.includes("queryQRLoginStatus") ? new Response("not-json") : base(url, init), "无效数据"]
  ]) {
    await t.test(name + " leaves no partial account", async t => {
      const h = harness(t, { fetch: fetchOverride });
      await h.run();
      h.assertEmpty();
      assert.ok(h.replies.at(-1).includes(expected), h.replies.at(-1));
      if (name.includes("not mislabeled")) assert.ok(!h.replies.at(-1).includes("过期"));
    });
  }

  for (const [name, confirmed, cookies] of [
    ["missing account identity", { status: "Confirmed", tokens: CONFIRMED.tokens }, []],
    ["conflicting account identities", CONFIRMED, ["ltuid=99999"]],
    ["ltoken is not an stoken", { ...CONFIRMED, tokens: [{ name: "ltoken", token: "ltoken-only" }] }, []]
  ]) {
    await t.test(name + " cannot persist or query roles", async t => {
      const h = harness(t, { confirmed, pollResponse: { cookies } });
      await h.run();
      h.assertEmpty();
      assert.ok(!h.requests.some(request => request.url.includes("getUserGameRolesByCookie")));
    });
  }

  await t.test("missing sender identity is rejected before creating a login ticket", async t => {
    const h = harness(t);
    const event = h.event("%扫码");
    delete event.sender;
    await h.handler({ event, vault: h.vault, matchedToken: "扫码", args: [] });
    h.assertEmpty();
    assert.equal(h.requests.length, 0);
    assert.ok(h.replies.at(-1).includes("身份不完整"));
  });

  await t.test("missing Vault is rejected before requesting a QR code", async t => {
    const h = harness(t);
    await h.handler({ event: h.event("%扫码"), matchedToken: "扫码", args: [] });
    assert.equal(h.requests.length, 0);
    assert.ok(h.replies.at(-1).includes("身份库不可用"));
  });

  await t.test("QR delivery failure ends the session before polling", async t => {
    const h = harness(t, { reply: async () => ({ success: false, error: "send failed" }) });
    await h.run();
    h.assertEmpty();
    assert.equal(h.requests.length, 1);
    assert.ok(h.replies.at(-1).includes("二维码发送失败"));
  });

  await t.test("encoding failure cleans up and does not poll", async t => {
    const h = harness(t, { handler: { encodeQr: async () => { throw new Error("encoding failed"); } } });
    await h.run();
    h.assertEmpty();
    assert.equal(h.requests.length, 1);
    await h.run("%扫码终止");
    assert.ok(h.replies.at(-1).includes("没有正在进行"));
  });

  for (const status of ["Expired", "Cancelled", "Unexpected"]) {
    await t.test(status + " is terminal and clears the session", async t => {
      const h = harness(t, { statuses: [status] });
      await h.run();
      h.assertEmpty();
      await h.run("%扫码终止");
      assert.ok(h.replies.at(-1).includes("没有正在进行"));
    });
  }

  await t.test("unconfirmed QR expires within a bounded number of requests", async t => {
    const h = harness(t, { statuses: ["Created"], handler: { loginTimeoutMs: 20, pollIntervalMs: 5 } });
    await h.run();
    h.assertEmpty();
    assert.ok(h.requests.length <= 5);
    assert.ok(h.replies.at(-1).includes("超时"));
  });

  await t.test("transient poll network failure can recover", async t => {
    let fail = true;
    const h = harness(t, { fetch: (url, init, base) => {
      if (url.includes("queryQRLoginStatus") && fail) {
        fail = false;
        throw new TypeError("fetch failed");
      }
      return base(url, init);
    } });
    await h.run();
    assert.ok(h.vault.getActiveRole(USER, "zzz"));
  });

  await t.test("repeated network failures end with a retryable error", async t => {
    const h = harness(t, { fetch: (url, init, base) => {
      if (url.includes("queryQRLoginStatus")) throw new TypeError("fetch failed");
      return base(url, init);
    } });
    await h.run();
    h.assertEmpty();
    assert.equal(h.requests.filter(request => request.url.includes("queryQRLoginStatus")).length, 3);
    assert.ok(h.replies.at(-1).includes("连续失败"));
  });

  await t.test("HTTP timeout aborts the request and releases the session", async t => {
    const h = harness(t, {
      fetch: (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
      handler: { requestTimeoutMs: 10 }
    });
    // AbortSignal.timeout 的计时器不保活进程，这个有界等待让测试观察其真实超时。
    await Promise.all([h.run(), delay(30)]);
    assert.ok(h.requests[0].init.signal.aborted);
    h.assertEmpty();
    await h.run("%扫码终止");
    assert.ok(h.replies.at(-1).includes("没有正在进行"));
  });

  for (const stage of ["createQRLogin", "queryQRLoginStatus", "getCookieAccountInfoBySToken", "getUserGameRolesByCookie"]) {
    await t.test("cancel while " + stage + " is in flight prevents late writes", async t => {
      const started = deferred();
      const pending = deferred();
      let request;
      const h = harness(t, { fetch: (url, init, base) => {
        if (url.includes(stage)) {
          request = { url, init, base };
          started.resolve();
          return pending.promise; // 故意模拟不遵守 signal 的晚到响应。
        }
        return base(url, init);
      } });
      const login = h.run();
      await started.promise;
      await h.run("%扫码终止");
      assert.ok(request.init.signal.aborted);
      const repliesAtCancel = h.replies.length;
      pending.resolve(await request.base(request.url, request.init));
      await login;
      h.assertEmpty();
      assert.equal(h.replies.length, repliesAtCancel, "late request must not emit new results");
      await h.run("%扫码终止");
      assert.ok(h.replies.at(-1).includes("没有正在进行"));
    });
  }

  for (const cancelNew of [false, true]) {
    await t.test("replaced old session cannot clean up new session (cancel new: " + cancelNew + ")", async t => {
      const firstStarted = deferred();
      const secondStarted = deferred();
      const first = deferred();
      const second = deferred();
      let polls = 0;
      const h = harness(t, { fetch: (url, init, base) => {
        if (!url.includes("queryQRLoginStatus")) return base(url, init);
        if (++polls === 1) { firstStarted.resolve(); return first.promise; }
        secondStarted.resolve();
        return second.promise;
      } });
      const oldLogin = h.run();
      await firstStarted.promise;
      const newLogin = h.run();
      await secondStarted.promise;
      first.resolve(api(CONFIRMED));
      await oldLogin;
      if (cancelNew) {
        await h.run("%扫码终止");
        assert.ok(h.replies.at(-1).includes("成功终止"), "new session must still occupy the slot");
      }
      second.resolve(api(CONFIRMED));
      await newLogin;
      if (cancelNew) h.assertEmpty();
      else assert.equal(h.replies.filter(reply => reply.includes("扫码绑定成功")).length, 1);
    });
  }

  await t.test("login write failure rolls back credentials, user, bindings and roles", async t => {
    const h = harness(t);
    const originalSave = h.vault.saveRoles.bind(h.vault);
    t.mock.method(h.vault, "saveRoles", (...args) => {
      originalSave(...args);
      throw new Error("simulated disk failure after role write");
    });
    await h.run();
    h.assertEmpty();
    assert.ok(h.replies.at(-1).includes("保存登录绑定失败"));
  });

  await t.test("refresh failure restores previous Cookie and selected role after nested activation", t => {
    const h = harness(t);
    const binding = {
      unifiedUserId: USER, platform: "qq-napcat", originalId: "12345", providerId: "mihoyo",
      accountKey: ACCOUNT, gameId: "zzz", cookies: { ck: "cookie_token=before==" },
      roles: ROLES.map(role => ({ ...role, uid: role.game_uid })), activeUid: "10009999"
    };
    h.vault.saveAccountBinding(binding);
    const switchRole = h.vault.setActiveRole.bind(h.vault);
    t.mock.method(h.vault, "setActiveRole", (...args) => {
      switchRole(...args);
      throw new Error("failure after activation");
    });
    assert.throws(() => h.vault.saveAccountBinding({ ...binding, cookies: { ck: "cookie_token=after==" }, activeUid: "17708598" }));
    const active = h.vault.getActiveRole(USER, "zzz");
    assert.equal(active.uid, "10009999");
    assert.equal(active.cookies.ck, "cookie_token=before==");
    assert.equal(h.vault.getUserRoles(USER, "zzz").length, 2);
    assert.equal(h.vault.foreignKeyCheck().length, 0);
  });

  await t.test("a role owned by another account cannot be reassigned by login", t => {
    const h = harness(t);
    const binding = {
      unifiedUserId: USER, platform: "qq-napcat", originalId: "12345", providerId: "mihoyo",
      accountKey: ACCOUNT, gameId: "zzz", cookies: { ck: "cookie_token=original==" },
      roles: [{ uid: "17708598", region: "prod_gf_cn", nickname: "哲", level: 60 }], activeUid: "17708598"
    };
    h.vault.saveAccountBinding(binding);
    assert.throws(() => h.vault.saveAccountBinding({
      ...binding, unifiedUserId: "qq-napcat:99999", originalId: "99999", accountKey: "20002"
    }), /归属/);
    assert.equal(h.vault.getActiveRole("qq-napcat:99999", "zzz"), null);
    assert.equal(h.vault.getActiveRole(USER, "zzz").cookies.ck, "cookie_token=original==");
    assert.equal(h.vault.db.prepare("SELECT COUNT(*) AS count FROM community_credentials").get().count, 1);
    assert.equal(h.vault.db.prepare("SELECT COUNT(*) AS count FROM chat_users").get().count, 1);
    assert.equal(h.vault.foreignKeyCheck().length, 0);
  });

  await t.test("Cookie survives database close/reopen and old raw/JSON-string formats remain readable", () => {
    const file = new URL("./_tmp_qr_" + crypto.randomUUID() + ".db", import.meta.url);
    const dbPath = fileURLToPath(file);
    let vault;
    try {
      vault = new IdentityVault(dbPath);
      vault.saveCredential("mihoyo", ACCOUNT, "ltuid=10001; cookie_token=persisted==");
      vault.bindUser(USER, "qq-napcat", "12345", "mihoyo", ACCOUNT);
      vault.saveRoles("mihoyo", ACCOUNT, "zzz", [{ uid: "17708598", region: "prod_gf_cn" }]);
      assert.doesNotThrow(() => JSON.parse(vault.db.prepare("SELECT cookies_json FROM community_credentials").get().cookies_json));
      vault.close();
      vault = new IdentityVault(dbPath);
      assert.equal(vault.getActiveRole(USER, "zzz").cookies.ck, "ltuid=10001; cookie_token=persisted==");
      for (const legacy of ["cookie_token=raw==", JSON.stringify("cookie_token=json-string==")]) {
        vault.db.prepare("UPDATE community_credentials SET cookies_json = ?").run(legacy);
        assert.ok(vault.getActiveRole(USER, "zzz").cookies.ck.includes("cookie_token="));
        assert.equal(vault.db.prepare("SELECT cookies_json FROM community_credentials").get().cookies_json, legacy, "legacy read must not rewrite storage");
      }
    } finally {
      vault?.close();
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });
});
