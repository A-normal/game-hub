import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { IdentityVault, GameHubDispatcher } from "../packages/core/src/index.mjs";
import { MihoyoCommunityProvider } from "../packages/provider/mihoyo/src/index.mjs";
import { ZZZPluginManifest } from "../packages/plugin/zzz/src/index.mjs";
import { NapCatGateway } from "../packages/channel/napcat/src/index.mjs";

test("NapCat End-to-End Vertical Slice Suite (NapCat → 绑定选角色 → 查询便签 → 回复)", async (t) => {
  const originalFetch = globalThis.fetch;
  const GATEWAY_PORT = 19895;
  const ACCESS_TOKEN = "napcat_secret_token_7788";

  // 1. 初始化核心组件
  const vault = new IdentityVault(":memory:");
  const provider = new MihoyoCommunityProvider();
  const dispatcher = new GameHubDispatcher({ vault });

  dispatcher.registerProvider(provider);
  dispatcher.registerPlugin(ZZZPluginManifest);

  const gateway = new NapCatGateway({
    host: "127.0.0.1",
    port: GATEWAY_PORT,
    path: "/onebot/v11/ws",
    accessToken: ACCESS_TOKEN,
    dispatcher
  });

  await gateway.start();

  // 模拟米哈游 API 网关响应
  let lastNoteQueryUid = "";
  globalThis.fetch = async (url, options) => {
    const urlStr = String(url);

    // 1.1 角色绑定查询接口
    if (urlStr.includes("/binding/api/getUserGameRolesByCookie")) {
      return {
        ok: true,
        json: async () => ({
          retcode: 0,
          message: "OK",
          data: {
            list: [
              { game_uid: "17708598", region: "prod_gf_cn", nickname: "哲", level: 60 },
              { game_uid: "10009999", region: "prod_gf_cn", nickname: "铃", level: 25 }
            ]
          }
        })
      };
    }

    // 1.2 绝区零实时便签查询接口
    if (urlStr.includes("/event/game_record_zzz/api/zzz/note")) {
      const urlObj = new URL(urlStr);
      lastNoteQueryUid = urlObj.searchParams.get("role_id") || "";
      const isZhe = lastNoteQueryUid === "17708598";

      return {
        ok: true,
        json: async () => ({
          retcode: 0,
          message: "OK",
          data: {
            energy: { current: isZhe ? 240 : 180, max: 240, restore_time: isZhe ? 0 : 3600 },
            vitality: { current: isZhe ? 500 : 200, max: 500 },
            vhs_sale: { sale_state: "SaleStateDone" },
            card_sign: "CardSignDone",
            weekly_tower: { cur_point: isZhe ? 21 : 6 }
          }
        })
      };
    }

    return { ok: true, json: async () => ({ retcode: 0, data: {} }) };
  };

  try {
    // =========================================================================
    // 2. 严格测试 P0-02：未鉴权或鉴权失败的连接必须被拒绝
    // =========================================================================
    await t.test("P0-02 Fix: Gateway rejects unauthorized connections on loopback", async () => {
      // 2.1 尝试使用错误 Token 连接
      const badWs = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}/onebot/v11/ws`, {
        headers: { Authorization: "Bearer bad_wrong_token" }
      });

      const err = await new Promise((resolve) => {
        badWs.on("error", (e) => resolve(e));
        badWs.on("open", () => resolve(null));
      });

      assert.ok(err, "Connecting with invalid token must trigger error/rejection");
    });

    // =========================================================================
    // 3. 完整端到端纵切链路演练
    // =========================================================================
    await t.test("End-to-End Vertical Slice: NapCat WS -> Bind Role -> Select Role -> Note Query -> Echo Reply", async () => {
      // 3.1 建立正常已鉴权的反向 WebSocket 连接 (模拟真实 NapCat 客户端)
      const napcatClient = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}/onebot/v11/ws`, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
      });

      await new Promise((resolve, reject) => {
        napcatClient.on("open", resolve);
        napcatClient.on("error", reject);
      });

      // 注册 NapCat 客户端消息监听器，自动响应 API echo 回包 (修复 P1-07)
      const receivedMessages = [];
      napcatClient.on("message", (data) => {
        const payload = JSON.parse(data.toString());

        // 如果收到了网关发过来的 send_msg 调用，捕获并回复 echo 确认
        if (payload.action === "send_msg") {
          receivedMessages.push(payload.params.message);

          // 回复 OneBot API 执行成功报文带上相同 echo
          napcatClient.send(JSON.stringify({
            status: "ok",
            retcode: 0,
            data: { message_id: 888800 + receivedMessages.length },
            echo: payload.echo
          }));
        }
      });

      const TEST_QQ_USER = 11223344;

      // -----------------------------------------------------------------------
      // Step A: 用户初次发送 *便签 -> 期望系统友好提示尚未绑定
      // -----------------------------------------------------------------------
      napcatClient.send(JSON.stringify({
        post_type: "message",
        message_type: "private",
        user_id: TEST_QQ_USER,
        message: "*便签",
        raw_message: "*便签",
        message_id: 1001
      }));

      // 等待回复
      while (receivedMessages.length < 1) {
        await new Promise(r => setTimeout(r, 20));
      }

      assert.ok(
        receivedMessages[0].includes("未检测到已激活的绝区零角色"),
        "Should prompt user to bind account before querying note"
      );

      // -----------------------------------------------------------------------
      // Step B: 用户发送 *绑定 <cookie> -> 期望成功发现角色并激活首个主角色
      // -----------------------------------------------------------------------
      napcatClient.send(JSON.stringify({
        post_type: "message",
        message_type: "private",
        user_id: TEST_QQ_USER,
        message: "*绑定 ltuid=100023456; ltoken=mock_ltoken_xyz;",
        raw_message: "*绑定 ltuid=100023456; ltoken=mock_ltoken_xyz;",
        message_id: 1002
      }));

      while (receivedMessages.length < 2) {
        await new Promise(r => setTimeout(r, 20));
      }

      const bindReply = receivedMessages[1];
      assert.ok(bindReply.includes("通行证绑定成功"), "Reply must confirm bind success");
      assert.ok(bindReply.includes("[17708598] 哲 (Lv.60) ★[当前主角色]"), "Must activate first role 17708598 by default");
      assert.ok(bindReply.includes("[10009999] 铃 (Lv.25)"), "Must list second role");

      // 验证身份保密库中存在唯一的激活角色
      const activeRoleB = vault.getActiveRole(`qq-napcat:${TEST_QQ_USER}`, "zzz");
      assert.equal(activeRoleB.uid, "17708598");

      // -----------------------------------------------------------------------
      // Step C: 用户发送 *便签 -> 期望准确查询并回复当前主角色 (哲) 的电量
      // -----------------------------------------------------------------------
      napcatClient.send(JSON.stringify({
        post_type: "message",
        message_type: "private",
        user_id: TEST_QQ_USER,
        message: "*便签",
        raw_message: "*便签",
        message_id: 1003
      }));

      while (receivedMessages.length < 3) {
        await new Promise(r => setTimeout(r, 20));
      }

      const noteReply1 = receivedMessages[2];
      assert.equal(lastNoteQueryUid, "17708598", "Must query Takumi API with UID 17708598");
      assert.ok(noteReply1.includes("绳匠: 哲 (UID: 17708598)"));
      assert.ok(noteReply1.includes("实时电量: 240 / 240 (已回满)"));
      assert.ok(noteReply1.includes("每日活跃: 500 / 500"));

      // -----------------------------------------------------------------------
      // Step D: 用户发送 *选角色 10009999 -> 期望成功将主角色切换为 铃
      // -----------------------------------------------------------------------
      napcatClient.send(JSON.stringify({
        post_type: "message",
        message_type: "private",
        user_id: TEST_QQ_USER,
        message: "*选角色 10009999",
        raw_message: "*选角色 10009999",
        message_id: 1004
      }));

      while (receivedMessages.length < 4) {
        await new Promise(r => setTimeout(r, 20));
      }

      const roleSwitchReply = receivedMessages[3];
      assert.ok(roleSwitchReply.includes("已成功将主角色切换为"));
      assert.ok(roleSwitchReply.includes("[10009999] 铃 (Lv.25)"));

      // 验证保密库状态已切换
      const activeRoleD = vault.getActiveRole(`qq-napcat:${TEST_QQ_USER}`, "zzz");
      assert.equal(activeRoleD.uid, "10009999", "Vault active role must now be 10009999");

      // -----------------------------------------------------------------------
      // Step E: 用户再次发送 *便签 -> 期望自动针对新主角色 (铃) 进行便签查询
      // -----------------------------------------------------------------------
      napcatClient.send(JSON.stringify({
        post_type: "message",
        message_type: "private",
        user_id: TEST_QQ_USER,
        message: "*便签",
        raw_message: "*便签",
        message_id: 1005
      }));

      while (receivedMessages.length < 5) {
        await new Promise(r => setTimeout(r, 20));
      }

      const noteReply2 = receivedMessages[4];
      assert.equal(lastNoteQueryUid, "10009999", "Must query Takumi API with switched UID 10009999");
      assert.ok(noteReply2.includes("绳匠: 铃 (UID: 10009999)"));
      assert.ok(noteReply2.includes("实时电量: 180 / 240"));
      assert.ok(noteReply2.includes("每日活跃: 200 / 500"));

      // 关闭连接
      napcatClient.close();
    });
  } finally {
    globalThis.fetch = originalFetch;
    await gateway.stop();
    vault.close();
  }
});
