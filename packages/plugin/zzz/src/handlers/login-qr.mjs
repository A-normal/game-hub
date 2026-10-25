/**
 * 米哈游扫码登录：授权、凭据校验、角色发现和原子绑定。
 * 默认保留已验证的 app 模式；“扫码 web”使用网页模式。
 */

import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { generateQrPngBase64 } from "../utils/qr-encoder.mjs";
import { logger } from "@game-hub/core";
import { issueDeviceFingerprint, androidHeaders } from "@game-hub/provider-mihoyo";

const PASSPORT = "https://passport-api.mihoyo.com";
const ROLES_URL = "https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie?game_biz=nap_cn";

class LoginError extends Error {}

function randomString(length) {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Array.from({ length }, () => chars[crypto.randomInt(chars.length)]).join("");
}

function calcDs() {
  const t = Math.floor(Date.now() / 1000);
  const r = randomString(6);
  const hash = crypto.createHash("md5")
    .update("salt=JwYDpKvLj6MrMqqYU6jTKF17KNO2PXoS&t=" + t + "&r=" + r + "&b=&q=")
    .digest("hex");
  return [t, r, hash].join(",");
}

function mergeResponseCookies(response, cookies) {
  const headers = typeof response.headers?.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers?.get("set-cookie") || ""];
  for (const header of headers) {
    // Expires 含逗号，只有紧接下一个 cookie-name= 的逗号才是分隔符。
    for (const entry of header.split(/,(?=\s*[^=;,\s]+=)/)) {
      const pair = entry.split(";")[0].trim();
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const key = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (value) cookies.set(key, value);
      else cookies.delete(key);
    }
  }
}

function cookieString(cookies) {
  return Array.from(cookies, ([key, value]) => key + "=" + value).join("; ");
}

function validateApi(data, stage) {
  if (!data || data.retcode !== 0 || !data.data || typeof data.data !== "object") {
    const code = Number.isInteger(data?.retcode) ? " (retcode: " + data.retcode + ")" : "";
    throw new LoginError(stage + "失败" + code + "，请重新发起扫码。");
  }
  return data.data;
}

function parseCredentials(data, cookies) {
  const info = data.user_info || {};
  const ids = [
    info.aid, info.uid, info.account_id,
    cookies.get("account_id"), cookies.get("account_id_v2"),
    cookies.get("ltuid"), cookies.get("ltuid_v2")
  ].filter(value => value !== undefined && value !== null && value !== "").map(String);
  const uid = ids[0];
  if (!uid || !/^\d+$/.test(uid) || ids.some(id => id !== uid)) {
    throw new LoginError("登录凭据中的通行证 ID 缺失或不一致，请重新扫码。");
  }

  const tokens = Array.isArray(data.tokens) ? data.tokens : [];
  for (const token of tokens) {
    if (!token || typeof token.token !== "string" || !token.token) continue;
    const name = token.name || token.token_name;
    if (["stoken", "stoken_v2", "ltoken", "ltoken_v2", "cookie_token", "cookie_token_v2"].includes(name)) {
      cookies.set(name, token.token);
    } else if (token.token_type === 1 || token.token_type === "1" ||
      (!name && token.token.startsWith("v2_"))) {
      cookies.set("stoken", token.token);
    }
  }

  const mid = info.mid || cookies.get("account_mid_v2") || cookies.get("ltmid_v2") || cookies.get("mid");
  cookies.set("account_id", uid);
  cookies.set("ltuid", uid);
  if (mid) cookies.set("mid", String(mid));
  return { uid, mid };
}

/**
 * 依赖注入用于以真实整形事件、真实 Vault 和可控官方响应测试完整状态流。
 * 不创建后台任务；整个登录生命周期由调用方 await。
 */
export function createLoginQrHandler({
  fetchImpl = (...args) => fetch(...args),
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
  now = () => Date.now(),
  encodeQr = generateQrPngBase64,
  pollIntervalMs = 3000,
  loginTimeoutMs = 180000,
  requestTimeoutMs = 15000
} = {}) {
  if (![pollIntervalMs, loginTimeoutMs, requestTimeoutMs].every(value => Number.isFinite(value) && value > 0)) {
    throw new TypeError("扫码超时和轮询间隔必须为正数");
  }
  const sessions = new Map();

  const isCurrent = session => sessions.get(session.userId) === session && !session.controller.signal.aborted;
  const assertCurrent = session => {
    if (!isCurrent(session)) throw new LoginError("扫码会话已取消");
    if (now() >= session.deadline) throw new LoginError("扫码超时未确认，请重新发起。");
  };

  async function requestJson(url, options, session) {
    assertCurrent(session);
    const timeout = Math.min(requestTimeoutMs, session.deadline - now());
    const signal = AbortSignal.any([session.controller.signal, AbortSignal.timeout(Math.max(1, Math.ceil(timeout)))]);
    const response = await fetchImpl(url, { ...options, redirect: "error", signal });
    assertCurrent(session);
    if (!response.ok) throw new LoginError("米哈游请求失败 (HTTP " + response.status + ")，请稍后重试。");
    let data;
    try {
      data = await response.json();
    } catch {
      throw new LoginError("米哈游接口返回了无效数据，请稍后重试。");
    }
    assertCurrent(session);
    return { response, data };
  }

  async function exchangeCookieToken(cookies, identity, device, session) {
    const stoken = cookies.get("stoken_v2") || cookies.get("stoken");
    if (!stoken || !identity.mid) {
      throw new LoginError("扫码授权未返回可用的 Cookie 凭据，请重新扫码。");
    }
    const query = new URLSearchParams({ stoken, uid: identity.uid, mid: String(identity.mid) });
    const { data } = await requestJson(PASSPORT + "/account/auth/api/getCookieAccountInfoBySToken?" + query, {
      method: "GET",
      headers: {
        "x-rpc-app_version": "2.104.0",
        DS: calcDs(),
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-rpc-game_biz": "bbs_cn",
        "x-rpc-sys_version": "12",
        "x-rpc-device_id": device.device_id,
        "x-rpc-device_fp": device.device_fp,
        "x-rpc-device_name": device.device_name || "Game-Hub",
        "x-rpc-device_model": device.device_model || "Standalone",
        "x-rpc-app_id": "bll8iq97cem8",
        "x-rpc-client_type": "2",
        "User-Agent": "Hyperion/550 CFNetwork/3860.500.112 Darwin/25.4.0",
        ...(device.device_android ? androidHeaders(device.device_android) : {}),
        Cookie: "stoken=" + stoken + "; stuid=" + identity.uid + "; mid=" + identity.mid
      }
    }, session);
    const result = validateApi(data, "换取登录凭据");
    if (!result.cookie_token) throw new LoginError("换取登录凭据失败：未返回 cookie_token，请重新扫码。");
    if (result.uid && String(result.uid) !== identity.uid) {
      throw new LoginError("换取的登录凭据与通行证 ID 不一致，请重新扫码。");
    }
    cookies.set("cookie_token", result.cookie_token);
  }

  return async function handleLoginQr(ctx) {
    if (ctx.event.isGroup) {
      await ctx.event.reply("请在私聊中发起或取消扫码登录，二维码属于私人授权凭据。");
      return { status: "DENIED" };
    }
    const userId = ctx.event.unifiedUserId;
    const args = ctx.args || [];
    const token = ctx.matchedToken || "";
    const isCancel = token.includes("终止") || token.includes("取消") ||
      ["终止", "取消", "stop"].includes(args[0]?.toLowerCase());
    if (isCancel) {
      const current = sessions.get(userId);
      if (current) {
        current.controller.abort();
        sessions.delete(userId);
      }
      await ctx.event.reply(current ? "【绝区零扫码】登录轮询已成功终止。" : "【绝区零扫码】当前没有正在进行的扫码会话。");
      return "return";
    }

    const originalId = ctx.event.sender?.id;
    const platform = ctx.event.platform;
    if (!userId || !platform || originalId === undefined || originalId === null ||
      !String(originalId).trim() || String(originalId) === "unknown") {
      await ctx.event.reply("【绝区零扫码】聊天用户身份不完整，无法绑定账号，请重新发送指令。");
      return "return";
    }
    if (typeof ctx.vault?.saveAccountBinding !== "function") {
      await ctx.event.reply("【绝区零扫码】身份库不可用，无法保存登录，请联系管理员。");
      return "return";
    }

    sessions.get(userId)?.controller.abort();
    const session = {
      userId,
      controller: new AbortController(),
      deadline: now() + loginTimeoutMs,
      stage: "创建二维码"
    };
    sessions.set(userId, session);
    const deviceId = randomString(16);
    let issuedDevice;
    const isWebMode = /\bweb\b|网页/i.test(ctx.event.cleanText || "");
    const endpoint = isWebMode ? "web" : "app";
    const headers = {
      "User-Agent": isWebMode
        ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        : "HYPContainer/1.3.3.182",
      "x-rpc-app_id": isWebMode ? "bll8iq97cem8" : "ddxf5dufpuyo",
      "x-rpc-device_id": deviceId,
      "Content-Type": "application/json"
    };
    if (!isWebMode) headers["x-rpc-client_type"] = "3";
    const passportRequest = (action, body) => requestJson(
      PASSPORT + "/account/ma-cn-passport/" + endpoint + "/" + action,
      { method: "POST", headers, body: JSON.stringify(body) }, session
    );

    try {
      session.stage="获取官方设备指纹";
      issuedDevice=await issueDeviceFingerprint({deviceId,fetchImpl,signal:session.controller.signal,timeoutMs:requestTimeoutMs});
      assertCurrent(session);
      headers["x-rpc-device_fp"]=issuedDevice.device_fp;
      logger.info("Plugin:zzz", "用户 " + userId + " 发起扫码登录 (模式: " + endpoint + ")");
      const created = await passportRequest("createQRLogin", {});
      const { url, ticket } = validateApi(created.data, "创建二维码");
      if (typeof url !== "string" || !url || typeof ticket !== "string" || !ticket) {
        throw new LoginError("创建二维码失败：米哈游接口未返回二维码地址或票据。");
      }
      const png = await encodeQr(url, { margin: 4, scale: 6 });
      assertCurrent(session);
      const sent = await ctx.event.reply([
        "📱 【绝区零 · 米哈游通行证扫码登录】",
        "请使用手机【米游社 App】扫描下方二维码并确认：",
        "[CQ:image,file=" + png + "]",
        "• 直达链接: " + url,
        "• 有效时间: 3 分钟",
        "💡 发送「" + ctx.commands.format({ routeId: "loginCancel" }) + "」可取消本次登录"
      ].join("\n"));
      assertCurrent(session);
      if (sent?.success === false) throw new LoginError("二维码发送失败，登录已结束，请重新发起。");

      session.stage = "查询扫码状态";
      const cookies = new Map();
      mergeResponseCookies(created.response, cookies);
      let confirmed = null;
      let scannedNotified = false;
      let networkFailures = 0;
      const maxAttempts = Math.ceil(loginTimeoutMs / pollIntervalMs);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        assertCurrent(session);
        await sleep(Math.min(pollIntervalMs, session.deadline - now()), session.controller.signal);
        assertCurrent(session);
        let poll;
        try {
          poll = await passportRequest("queryQRLoginStatus", { ticket });
          networkFailures = 0;
        } catch (error) {
          assertCurrent(session);
          if (error instanceof LoginError) throw error;
          if (++networkFailures >= 3) throw new LoginError("查询扫码状态连续失败，请稍后重新扫码。");
          continue;
        }
        const result = validateApi(poll.data, "查询扫码状态");
        mergeResponseCookies(poll.response, cookies);
        if (result.status === "Confirmed") {
          confirmed = result;
          break;
        }
        if (result.status === "Scanned") {
          if (!scannedNotified) {
            scannedNotified = true;
            await ctx.event.reply("📱 二维码已扫描，请在手机【米游社 App】上点击「确认登录」...");
            assertCurrent(session);
          }
        } else if (["Expired", "Cancelled", "Canceled"].includes(result.status)) {
          throw new LoginError("二维码已过期或授权已取消，请重新扫码。");
        } else if (!["Created", "Init", "Pending"].includes(result.status)) {
          throw new LoginError("米哈游接口返回了未知扫码状态，请重新扫码。");
        }
      }
      if (!confirmed) throw new LoginError("扫码超时未确认，登录已结束，请重新发起。");

      session.stage = "校验登录凭据";
      const identity = parseCredentials(confirmed, cookies);
      // 只能复用这次已确认账号的设备，不能从另一个主角色借用。
      const bindingBefore = ctx.vault.getUserCredential?.(userId, "mihoyo", identity.uid) || null;
      const existing = args.includes("重建设备") ? {} : bindingBefore?.device || {};
      const device = {
        ...existing,
        device_id: existing.device_id || deviceId,
        ...(existing.device_fp ? {} : existing.device_id ? await issueDeviceFingerprint({deviceId:existing.device_id,mobile:existing.device_android,fetchImpl,signal:session.controller.signal,timeoutMs:requestTimeoutMs}) : issuedDevice)
      };
      if (!cookies.get("cookie_token") && !cookies.get("cookie_token_v2")) {
        await exchangeCookieToken(cookies, identity, device, session);
      }
      const fullCookies = cookieString(cookies);
      session.stage = "获取绝区零角色";
      const rolesResponse = await requestJson(ROLES_URL, {
        headers: {
          "User-Agent": "Hyperion/550 CFNetwork/3860.500.112 Darwin/25.4.0",
          "x-rpc-device_id": device.device_id,
          "x-rpc-device_fp": device.device_fp,
          ...(device.device_android ? androidHeaders(device.device_android) : {}),
          Cookie: fullCookies
        }
      }, session);
      const roleData = validateApi(rolesResponse.data, "查询绝区零角色");
      if (!Array.isArray(roleData.list)) throw new LoginError("绝区零角色列表格式异常，本次登录未保存，请重新扫码。");
      const roles = roleData.list.map(role => {
        if (!role || !/^\d+$/.test(String(role.game_uid || "")) ||
          typeof role.region !== "string" || !role.region) {
          throw new LoginError("绝区零角色数据不完整，本次登录未保存，请重新扫码。");
        }
        return {
          uid: String(role.game_uid),
          region: role.region,
          nickname: String(role.nickname || "绳匠"),
          level: Math.max(0, Number(role.level) || 0)
        };
      });
      const primary = roles.reduce((best, role) => !best || role.level > best.level ? role : best, null);
      // 重复扫码保留用户手动选过的主角色；只有该角色不属于这次登录时才回落到最高等级角色。
      const previous = typeof ctx.vault?.getActiveRole === "function" ? ctx.vault.getActiveRole(userId, "zzz") : null;
      const keepActive = previous && roles.some(role => role.uid === previous.uid && role.region === previous.region);
      const activeUid = keepActive ? previous.uid : primary?.uid;

      assertCurrent(session);
      session.stage = "保存登录绑定";
      const bindingNow=ctx.vault.getUserCredential?.(userId,"mihoyo",identity.uid) || null;
      if(Boolean(bindingBefore)!==Boolean(bindingNow) || JSON.stringify(bindingBefore?.device)!==JSON.stringify(bindingNow?.device)) {
        throw new LoginError("登录期间账号绑定或设备配置已变化，本次未覆盖配置，请重新扫码。");
      }
      ctx.vault.saveAccountBinding({
        unifiedUserId: userId,
        platform,
        originalId: String(originalId),
        providerId: "mihoyo",
        accountKey: identity.uid,
        gameId: "zzz",
        cookies: { ck: fullCookies },
        device,
        roles,
        activeUid
      });
      logger.info("Plugin:zzz", "用户 " + userId + " 扫码绑定已保存，绝区零角色数: " + roles.length);
      session.stage = "发送登录结果";
      const shown = keepActive && previous && primary && previous.uid !== primary.uid
        ? roles.find(role => role.uid === previous.uid) || primary
        : primary;
      await ctx.event.reply(shown ? [
        "🎉 【米游社账号扫码绑定成功】",
        "• 通行证 ID: " + identity.uid,
        "• 绳匠昵称: " + shown.nickname,
        "• 绳网 UID: " + shown.uid + " (" + shown.region + ")",
        "• 绳网等级: " + shown.level + " 级",
        keepActive ? "✅ 已保留原先的主角色，登录凭据已更新。" : "✅ 已设为主激活角色，登录凭据已保存。",
        "💡 可使用「" + ctx.commands.format({ routeId: "note" }) + "」查询。"
      ].join("\n") : [
        "🎉 【米游社账号扫码登录成功】",
        "• 通行证 ID: " + identity.uid,
        "⚠️ 此通行证未绑定绝区零游戏角色。登录已保存，请确认已在游戏中创建角色。"
      ].join("\n"));
    } catch (error) {
      if (isCurrent(session)) {
        const message = error instanceof LoginError ? error.message : session.stage + "失败，请稍后重试。";
        // 不记录上游完整响应、Cookie、ticket 或带 stoken 的 URL。
        logger.warn("Plugin:zzz", "用户 " + userId + " 扫码登录失败，阶段: " + session.stage);
        await ctx.event.reply("【绝区零扫码】" + message);
      }
    } finally {
      // 只有当前会话才能清理自己的槽位，避免旧请求误删后发起的会话。
      if (sessions.get(userId) === session) sessions.delete(userId);
      session.controller.abort();
    }
    return "return";
  };
}

export const handleLoginQr = createLoginQrHandler();
export default handleLoginQr;
