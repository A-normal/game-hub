import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { IdentityVault } from "../packages/core/src/identity/vault.mjs";
import { importGachaJson } from "../tools/import-gacha.mjs";

test("Identity Vault & Data Integrity Test Suite", async (t) => {
  // =========================================================================
  // 1. 严格复现与验证 P0-01：重新保存凭据不触发 ON DELETE CASCADE 误删关系
  // =========================================================================
  await t.test("P0-01 Fix: saveCredential using ON CONFLICT DO UPDATE preserves existing bindings and roles", () => {
    const vault = new IdentityVault(":memory:");

    const providerId = "mihoyo";
    const accountKey = "100023456";
    const unifiedUserId = "qq:998877";

    // 1.1 首次录入凭据、绑定和角色
    vault.saveCredential(providerId, accountKey, { ltuid: "100023456", ltoken: "initial_token" }, { device_id: "dev-1" });
    vault.bindUser(unifiedUserId, "qq-napcat", "998877", providerId, accountKey);
    vault.saveRoles(providerId, accountKey, "zzz", [
      { uid: "17708598", region: "prod_gf_cn", nickname: "哲", level: 60 }
    ]);

    // 验证初始状态：绑定为 1，角色为 1
    const initialBindings = vault.db.prepare("SELECT count(*) as c FROM user_community_bindings").get();
    const initialRoles = vault.db.prepare("SELECT count(*) as c FROM game_roles").get();
    assert.equal(initialBindings.c, 1, "Initial bindings count must be 1");
    assert.equal(initialRoles.c, 1, "Initial roles count must be 1");

    // 1.2 重跑 saveCredential（模拟用户更新 Cookie 或重刷登录）
    vault.saveCredential(providerId, accountKey, { ltuid: "100023456", ltoken: "refreshed_token" }, { device_id: "dev-1-updated" });

    // 验证核心修复：关系没有被级联删除，数量依然为 1！
    const afterBindings = vault.db.prepare("SELECT count(*) as c FROM user_community_bindings").get();
    const afterRoles = vault.db.prepare("SELECT count(*) as c FROM game_roles").get();
    assert.equal(afterBindings.c, 1, "P0-01 Fix: Bindings MUST NOT be deleted after saveCredential re-run");
    assert.equal(afterRoles.c, 1, "P0-01 Fix: Roles MUST NOT be deleted after saveCredential re-run");

    // 验证凭据字段成功更新（凭据落库为密文，通过公开读取路径校验明文）
    const refreshed = vault.getUserCredential(unifiedUserId, providerId, accountKey);
    assert.equal(refreshed?.cookies?.ltoken, "refreshed_token", "Credentials must be updated");

    // 验证外键无任何悬挂损坏
    const fkViolations = vault.foreignKeyCheck();
    assert.equal(fkViolations.length, 0, "No foreign key violations should exist");

    vault.close();
  });

  // =========================================================================
  // 2. 严格验证 P1-06：单用户单游戏下唯一主角色约束与安全切换
  // =========================================================================
  await t.test("P1-06 Fix: Exactly one active role per user and game with deterministic role switching", () => {
    const vault = new IdentityVault(":memory:");

    const providerId = "mihoyo";
    const accountKey = "100023456";
    const unifiedUserId = "qq:998877";

    vault.saveCredential(providerId, accountKey, { ltuid: "100023456", ltoken: "test" });
    vault.bindUser(unifiedUserId, "qq-napcat", "998877", providerId, accountKey);

    // 批量录入两个角色
    vault.saveRoles(providerId, accountKey, "zzz", [
      { uid: "17708598", region: "prod_gf_cn", nickname: "主角色-哲", level: 60 },
      { uid: "10009999", region: "prod_gf_cn", nickname: "副角色-铃", level: 30 }
    ]);

    // 2.1 验证首个角色默认激活
    const active1 = vault.getActiveRole(unifiedUserId, "zzz");
    assert.ok(active1, "Active role must be resolved");
    assert.equal(active1.uid, "17708598");

    // 验证数据库中仅有一条 is_active = 1
    const activeCount1 = vault.db.prepare("SELECT count(*) as c FROM game_roles WHERE is_active = 1").get();
    assert.equal(activeCount1.c, 1, "Exactly one active role must exist");

    // 2.2 切换角色至 10009999
    const switchSuccess = vault.setActiveRole(unifiedUserId, "zzz", "10009999");
    assert.equal(switchSuccess, true, "Role switch should succeed");

    const active2 = vault.getActiveRole(unifiedUserId, "zzz");
    assert.equal(active2.uid, "10009999");
    assert.equal(active2.nickname, "副角色-铃");

    const activeCount2 = vault.db.prepare("SELECT count(*) as c FROM game_roles WHERE is_active = 1").get();
    assert.equal(activeCount2.c, 1, "After switch, still exactly one active role must exist");

    // 2.3 尝试切换至不存在的角色 -> 应返回 false 且当前激活角色不受影响
    const fakeSwitch = vault.setActiveRole(unifiedUserId, "zzz", "88888888");
    assert.equal(fakeSwitch, false, "Switching to non-existent UID must return false");

    const active3 = vault.getActiveRole(unifiedUserId, "zzz");
    assert.equal(active3.uid, "10009999", "Active role must remain unchanged on invalid switch");

    vault.close();
  });

  // =========================================================================
  // 3. 验证抽卡记录 JSON 显式手动导入工具 (tools/import-gacha.mjs)
  // =========================================================================
  await t.test("Gacha Manual Import Tool: Safe idempotent UIGF import", () => {
    const vault = new IdentityVault(":memory:");
    const binding={owner:"mock:import",uid:"17708598"};
    vault.saveAccountBinding({unifiedUserId:binding.owner,platform:"mock",originalId:"import",providerId:"mihoyo",accountKey:"account",gameId:"zzz",cookies:{ck:"fixture"},roles:[{uid:binding.uid,region:"prod_gf_cn",nickname:"import"}]});

    // 构造临时测试抽卡 JSON 文件
    const tmpFile = "./tests/_tmp_gacha_test.json";
    const mockGachaData = {
      info: { uid: "17708598", lang: "zh-cn" },
      list: [
        { id: "1001", uid: "17708598", gacha_type: "2001", item_type: "代理人", name: "艾莲", rank_type: 4, time: "2024-07-04 12:00:00" },
        { id: "1002", uid: "17708598", gacha_type: "3001", item_type: "音擎", name: "深海访客", rank_type: 4, time: "2024-07-04 12:01:00" },
        { id: "1003", uid: "17708598", gacha_type: "2001", item_type: "代理人", name: "苍角", rank_type: 3, time: "2024-07-04 12:02:00" },
        { id: "1004", uid: "17708598", gacha_type: "2001", item_type: "音擎", name: "残响-一型", rank_type: 2, time: "2024-07-04 12:03:00" }
      ]
    };

    fs.writeFileSync(tmpFile, JSON.stringify(mockGachaData, null, 2), "utf8");

    try {
      // 首次导入
      const stats1 = importGachaJson(tmpFile, vault,binding);
      assert.equal(stats1.added, 4);
      assert.equal(stats1.sRanks, 2);
      assert.equal(stats1.aRanks, 1);

      const totalRows1 = vault.db.prepare("SELECT count(*) as c FROM zzz_gacha").get();
      assert.equal(totalRows1.c, 4);

      // 再次重跑导入（验证幂等性，不产生重复主键也不报错）
      const stats2 = importGachaJson(tmpFile, vault,binding);
      assert.equal(stats2.added, 0);
      assert.throws(()=>importGachaJson(tmpFile,vault,{owner:"other:import",uid:binding.uid}),/绑定/);

      const totalRows2 = vault.db.prepare("SELECT count(*) as c FROM zzz_gacha").get();
      assert.equal(totalRows2.c, 4, "Total rows must remain 4 after re-importing identical records");
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      vault.close();
    }
  });
});
