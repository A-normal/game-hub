import test from "node:test";
import assert from "node:assert/strict";
import { MihoyoTakumiClient } from "../packages/provider/mihoyo/src/client.mjs";
import { getDs1, getDs2, SALTS } from "../packages/provider/mihoyo/src/signer.mjs";

test("Mihoyo Provider & Takumi Client Rigorous Verification Suite (Resolving P1-03)", async (t) => {
  // 保存原生 fetch 引用
  const originalFetch = globalThis.fetch;

  // =========================================================================
  // 1. 验证 DS1 与 DS2 动态签名生成
  // =========================================================================
  await t.test("DS1 and DS2 dynamic secret algorithm validation", () => {
    const ds1 = getDs1("role_id=17708598&server=prod_gf_cn", "");
    const parts1 = ds1.split(",");
    assert.equal(parts1.length, 3, "DS1 must have 3 comma-separated components: t, r, hash");
    assert.equal(parts1[2].length, 32, "DS1 hash must be 32-character hex MD5");

    const ds2 = getDs2("", '{"test":"body"}');
    const parts2 = ds2.split(",");
    assert.equal(parts2.length, 3, "DS2 must have 3 components");
    assert.equal(parts2[2].length, 32, "DS2 hash must be 32-character hex MD5");
  });

  // =========================================================================
  // 2. 严格验证 P1-03：真实将 Query 拼入 URL，并完整装配设备指纹与签名头
  // =========================================================================
  await t.test("P1-03 Fix: Query parameters are properly appended to target URL and headers are assembled", async () => {
    let capturedUrl = "";
    let capturedOptions = null;

    // 模拟底层网络调用
    globalThis.fetch = async (url, options) => {
      capturedUrl = String(url);
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ retcode: 0, message: "OK", data: { energy: { current: 240, max: 240 } } })
      };
    };

    try {
      const client = new MihoyoTakumiClient(
        { ltuid: "10001", ltoken: "fake_token_abc" },
        { device_id: "test-device-uuid-999", device_fp: "38d7f8a9b0c1" }
      );

      // 发起请求：相对路径 + query
      const res = await client.request("/game_record/app/zzz/api/note", {
        method: "GET",
        query: { role_id: "17708598", server: "prod_gf_cn" },
        server: "prod_gf_cn",
        scope: "record"
      });

      assert.equal(res.retcode, 0);

      // 核心断言 1：URL 必须真实包含 query 字符串 (解决 P1-03: URL 无 query 问题)
      assert.ok(
        capturedUrl.includes("role_id=17708598&server=prod_gf_cn"),
        `Captured URL [${capturedUrl}] MUST contain serialized query parameters`
      );
      assert.ok(
        capturedUrl.startsWith("https://api-takumi-record.mihoyo.com/game_record/app/zzz/api/note"),
        "URL must point to the domestic record base domain"
      );

      // 核心断言 2：设备指纹与客户端版本头必须完整装配 (解决 P1-03)
      assert.equal(capturedOptions.headers["x-rpc-app_version"], "2.73.1");
      assert.equal(capturedOptions.headers["x-rpc-client_type"], "5");
      assert.equal(capturedOptions.headers["x-rpc-device_id"], "test-device-uuid-999");
      assert.equal(capturedOptions.headers["x-rpc-device_fp"], "38d7f8a9b0c1");

      // 核心断言 3：DS 动态签名头必须生成且非空 (解决 P1-03)
      assert.ok(capturedOptions.headers.DS && capturedOptions.headers.DS.split(",").length === 3);

      // 核心断言 4：Cookie 必须正确拼接为 ltuid 与 ltoken
      assert.ok(capturedOptions.headers.Cookie.includes("ltuid=10001"));
      assert.ok(capturedOptions.headers.Cookie.includes("ltoken=fake_token_abc"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // =========================================================================
  // 3. 严格验证 P1-03：POST Body 必须被真实序列化并传入 fetch 调用
  // =========================================================================
  await t.test("P1-03 Fix: POST body is properly serialized and transmitted", async () => {
    let capturedOptions = null;

    globalThis.fetch = async (url, options) => {
      capturedOptions = options;
      return {
        ok: true,
        json: async () => ({ retcode: 0, message: "OK", data: { success: true } })
      };
    };

    try {
      const client = new MihoyoTakumiClient("ltuid=123; ltoken=xyz;");
      const postPayload = { role_id: "17708598", server: "prod_gf_cn" };

      await client.post("/game_record/app/zzz/api/avatar/basic", postPayload, {
        server: "prod_gf_cn",
        scope: "record"
      });

      // 核心断言：body 必须以 JSON 字符串形式被传入 fetch (解决 P1-03)
      assert.equal(
        capturedOptions.body,
        JSON.stringify(postPayload),
        "POST body must be serialized to JSON and sent via fetch"
      );
      assert.ok(
        capturedOptions.headers["Content-Type"].includes("application/json"),
        "Content-Type header must be set to application/json"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // =========================================================================
  // 4. 验证海外服 URL 自动路由
  // =========================================================================
  await t.test("Overseas server automatically switches to HoYoLAB domain", async () => {
    let capturedUrl = "";

    globalThis.fetch = async (url) => {
      capturedUrl = String(url);
      return { ok: true, json: async () => ({ retcode: 0, data: {} }) };
    };

    try {
      const client = new MihoyoTakumiClient("cookie=abc");
      await client.get("/game_record/app/zzz/api/note", {
        query: { role_id: "1000123456", server: "prod_gf_us" },
        server: "prod_gf_us"
      });

      assert.ok(
        capturedUrl.startsWith("https://sg-act-public-api.hoyolab.com"),
        `Captured URL [${capturedUrl}] must route to bbs-api-os.hoyolab.com for overseas servers`
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
