/**
 * @file packages/provider-mihoyo/src/client.mjs
 * @description 米哈游 Takumi 专用请求客户端
 * 彻底解决 P1-03 审查缺陷：
 * 1. 真实将 Query 拼接入请求 URL；
 * 2. 真实序列化 Body 并传入 fetch；
 * 3. 完整装配设备指纹头 (x-rpc-device_fp / device_id)；
 * 4. 统一解析与传递 CookieJar。
 */

import crypto from "node:crypto";
import { getDs1, getDs2 } from "./signer.mjs";

export class MihoyoTakumiClient {
  /**
   * @param {string | Record<string, any>} cookies - 账号凭据
   * @param {Object} [device] - 设备指纹信息
   * @param {string} [device.device_id]
   * @param {string} [device.device_fp]
   * @param {string} [device.device_name]
   * @param {string} [device.device_model]
   */
  constructor(cookies = {}, device = {}) {
    this.cookieString = this._normalizeCookies(cookies);
    this.device = this._normalizeDevice(device);
  }

  _normalizeCookies(cookies) {
    if (!cookies) return "";
    if (typeof cookies === "string") return cookies.trim();
    if (cookies.ck && typeof cookies.ck === "string") return cookies.ck.trim();
    if (cookies.cookie && typeof cookies.cookie === "string") return cookies.cookie.trim();

    return Object.entries(cookies)
      .filter(([_, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  _normalizeDevice(device = {}) {
    return {
      deviceId: device.device_id || crypto.randomUUID(),
      deviceFp: device.device_fp || "38d7f8a9b0c1",
      deviceName: device.device_name || "Xiaomi 23049RAD8C",
      deviceModel: device.device_model || "23049RAD8C"
    };
  }

  /**
   * 判断服务器类型并选择对应的 Base URL
   */
  _resolveBaseUrl(endpoint, server = "prod_gf_cn", scope = "record") {
    if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
      return endpoint;
    }

    const isOverseas = ["prod_gf_us", "prod_gf_eu", "prod_gf_jp", "prod_gf_sg"].includes(server);

    let domain = "";
    if (scope === "record") {
      domain = isOverseas ? "https://bbs-api-os.hoyolab.com" : "https://api-takumi-record.mihoyo.com";
    } else {
      domain = isOverseas ? "https://api-os-takumi.hoyolab.com" : "https://api-takumi.mihoyo.com";
    }

    const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    return `${domain}${cleanEndpoint}`;
  }

  /**
   * 发起受保护的 Takumi 请求
   * @param {string} endpoint - 相对路径或绝对 URL
   * @param {Object} [options]
   * @param {'GET' | 'POST'} [options.method='GET']
   * @param {Record<string, any>} [options.query] - URL 查询参数
   * @param {Record<string, any>} [options.params] - 查询参数别名
   * @param {any} [options.body] - 请求体
   * @param {string} [options.server='prod_gf_cn'] - 目标区服
   * @param {'record' | 'api' | 'bbs'} [options.scope='record']
   * @param {Record<string, string>} [options.headers]
   * @returns {Promise<any>}
   */
  async request(endpoint, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const server = options.server || "prod_gf_cn";
    const scope = options.scope || "record";

    // 1. 解析完整 URL
    let targetUrl = this._resolveBaseUrl(endpoint, server, scope);

    // 2. 真实处理 Query 参数并拼接入 URL (修复 P1-03: URL 无 query 问题)
    const rawQuery = options.query || options.params || {};
    const searchParams = new URLSearchParams();
    for (const [k, v] of Object.entries(rawQuery)) {
      if (v !== undefined && v !== null) {
        searchParams.append(k, String(v));
      }
    }
    const queryString = searchParams.toString();
    if (queryString) {
      targetUrl += (targetUrl.includes("?") ? "&" : "?") + queryString;
    }

    // 3. 真实处理 POST Body (修复 P1-03: body 未发送问题)
    let bodyStr = "";
    if (options.body !== undefined && options.body !== null) {
      bodyStr = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }

    // 4. 计算 DS 动态签名 (使用统一的 queryString 与 bodyStr)
    const ds = scope === "bbs" ? getDs2(queryString, bodyStr) : getDs1(queryString, bodyStr);

    // 5. 完整装配请求头 (修复 P1-03: device_fp 与指纹头装配)
    const headers = {
      "x-rpc-app_version": "2.71.1",
      "x-rpc-client_type": "5",
      "x-rpc-device_id": this.device.deviceId,
      "x-rpc-device_fp": this.device.deviceFp,
      "x-rpc-device_name": this.device.deviceName,
      "x-rpc-device_model": this.device.deviceModel,
      "x-rpc-sys_version": "14",
      "DS": ds,
      "Cookie": this.cookieString,
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (Linux; Android 14; 23049RAD8C Build/UKQ1.230917.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.134 Mobile Safari/537.36 miHoYoBBS/2.71.1",
      ...(options.headers || {})
    };

    if (bodyStr) {
      headers["Content-Type"] = "application/json;charset=UTF-8";
    }

    // 6. 发起原生网络调用
    const fetchOptions = {
      method,
      headers,
      body: bodyStr || undefined
    };

    const response = await fetch(targetUrl, fetchOptions);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  }

  get(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: "GET" });
  }

  post(endpoint, body, options = {}) {
    return this.request(endpoint, { ...options, method: "POST", body });
  }

  /**
   * 查询角色绑定列表 (用于 *绑定 指令发现用户的全部绝区零角色)
   */
  async getUserGameRoles(gameBiz = "nap_cn") {
    const url = "https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie";
    const res = await this.request(url, {
      method: "GET",
      query: { game_biz: gameBiz },
      scope: "api"
    });
    if (res?.retcode !== 0) {
      throw new Error(res?.message || `获取绑定角色失败 (retcode: ${res?.retcode})`);
    }
    return res?.data?.list || [];
  }

  /**
   * 查询绝区零实时便签
   */
  async getDailyNote(uid, server = "prod_gf_cn") {
    const endpoint = "/game_record/app/zzz/api/note";
    const res = await this.get(endpoint, {
      query: { role_id: uid, server },
      server,
      scope: "record"
    });
    if (res?.retcode !== 0) {
      throw new Error(res?.message || `获取绝区零便签失败 (retcode: ${res?.retcode})`);
    }
    return res.data;
  }
}

export default MihoyoTakumiClient;
