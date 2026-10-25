import crypto from "node:crypto";
import { signDs, SALTS } from "./signer.mjs";
import { androidHeaders } from "./android-profile.mjs";

export class MihoyoError extends Error {
  constructor(code, publicMessage, retcode) { super(code); this.name = "MihoyoError"; this.code = code; this.publicMessage = publicMessage; this.retcode = retcode; }
}
export const isOverseas = region => region !== "prod_gf_cn";
export const cookieString = cookies => typeof cookies === "string" ? cookies.trim() : cookies?.ck || cookies?.cookie || Object.entries(cookies || {}).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => k + "=" + v).join("; ");
const allowedHosts = new Set(["api-takumi.mihoyo.com", "api-takumi-record.mihoyo.com", "api-takumi-static.mihoyo.com", "bbs-api.miyoushe.com", "sg-public-api.hoyolab.com", "sg-act-public-api.hoyolab.com", "public-operation-nap.mihoyo.com", "public-operation-nap-sg.hoyoverse.com", "public-operation-common.mihoyo.com", "public-operation-common-sg.hoyoverse.com"]);
export const RECORDS = Object.freeze({
  index: ["index", "role"], avatars: ["avatar/basic", "role"], avatar: ["avatar/info", "role"], buddies: ["buddy/info", "role"], note: ["note", "role"],
  shiyu: ["hadal_info_v2", "role", true], deadly: ["hadal_mem_detail_v2", "uid", true], holo: ["holo_boss_detail", "uid", true],
  tower: ["climbing_tower_detail", "uid"], void: ["void_front_battle_period_detail", "uid", true],
  hollow: ["abyss_abstract", "role"], hollowDetail: ["abyss_detail", "role"], hollow2: ["abysss2_abstract", "uid"],
  zenkov: ["zenkov_abstract_info", "uid"], zenkovDetail: ["zenkov_detail", "uid"], exploration: ["exploration_detail", "uid"],
  calendar: ["activity_calendar", "uid"], pools: ["gacha_calendar", "uid"]
});
export class MihoyoTakumiClient {
  constructor(cookies = {}, device = {}, options = {}) {
    this.cookieString = cookieString(cookies);
    this.device = { deviceId: device.device_id || crypto.randomUUID(), deviceFp: device.device_fp, deviceName: device.device_name, deviceModel: device.device_model, android:device.device_android };
    this.fetch = options.fetchImpl || ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.signer = options.sign || signDs;
  }
  _resolveBaseUrl(endpoint, server = "prod_gf_cn", scope = "record") {
    if (/^https?:\/\//.test(endpoint)) return endpoint;
    const host = scope === "record" ? (isOverseas(server) ? "sg-act-public-api.hoyolab.com" : "api-takumi-record.mihoyo.com") : (isOverseas(server) ? "sg-public-api.hoyolab.com" : "api-takumi.mihoyo.com");
    return "https://" + host + "/" + endpoint.replace(/^\//, "");
  }
  async request(endpoint, options = {}) {
    const server = options.server || "prod_gf_cn";
    const url = new URL(this._resolveBaseUrl(endpoint, server, options.scope));
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || url.username || url.password || url.port && url.port !== "443") throw new MihoyoError("UNSAFE_URL", "接口地址不在允许范围。");
    for (const [key, value] of Object.entries(options.query || options.params || {})) {
      if (value === undefined || value === null) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(Array.isArray(value) ? key + "[]" : key, String(item));
    }
    url.searchParams.sort();
    const body = options.body === undefined ? "" : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    const publicRequest = options.public === true;
    const headers = {
      Accept: "application/json", "User-Agent": "Game-Hub/1.0",
      ...(publicRequest ? {} : {
        Cookie: this.cookieString, "x-rpc-app_version": "2.73.1", "x-rpc-client_type": isOverseas(server) ? "2" : "5",
        "x-rpc-device_id": this.device.deviceId, Origin: isOverseas(server) ? "https://act.hoyolab.com" : "https://act.mihoyo.com",
        Referer: isOverseas(server) ? "https://act.hoyolab.com/" : "https://act.mihoyo.com/",
        DS: this.signer({ salt: options.generation === 1 ? SALTS.community : isOverseas(server) ? SALTS.overseas : SALTS.record, generation: options.generation || 2, query: decodeURIComponent(url.search.slice(1)), body })
      }),
      ...(this.device.deviceFp && !publicRequest ? { "x-rpc-device_fp": this.device.deviceFp } : {}),
      ...(this.device.deviceName && !publicRequest ? { "x-rpc-device_name": this.device.deviceName } : {}),
      ...(this.device.deviceModel && !publicRequest ? { "x-rpc-device_model": this.device.deviceModel } : {}),
      ...(!publicRequest && this.device.android ? androidHeaders(this.device.android) : {}),
      ...(body ? { "Content-Type": "application/json;charset=UTF-8" } : {}), ...(options.headers || {})
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url.href, { method: options.method || "GET", headers, body: body || undefined, redirect: "error", signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
      if (!response.ok) throw new MihoyoError("HTTP", "社区服务暂时不可用（HTTP " + response.status + "）。");
      let data; try { data=await response.json(); } catch { throw new MihoyoError("SCHEMA","社区返回的数据格式异常。"); }
      if (!Number.isInteger(data?.retcode)) throw new MihoyoError("SCHEMA", "社区返回的数据格式异常。");
      return data;
    } catch (error) {
      if (error instanceof MihoyoError) throw error;
      throw new MihoyoError(controller.signal.aborted ? "TIMEOUT" : "NETWORK", controller.signal.aborted ? "社区请求超时，请稍后重试。" : "社区网络请求失败，请稍后重试。");
    } finally { clearTimeout(timer); }
  }
  async data(endpoint, options = {}) {
    const response = await this.request(endpoint, options);
    if (response.retcode !== 0) {
      const code = response.retcode;
      const message = [-100, -101, 10001, 10002, -10001].includes(code) ? "登录凭据已失效，请重新登录。" : [10102, 10103].includes(code) ? "游戏数据未公开或无查询权限。" : code === 1034 ? "社区要求安全验证，请在官方客户端完成验证后重试。" : code === 10041 ? "米游社拒绝当前请求的设备或安全校验（10041）。官方 App 正常时，也可能是机器人设备与凭据环境不匹配。" : "社区接口拒绝请求（代码 " + code + "）。";
      throw new MihoyoError("API", message, code);
    }
    if (!response.data || typeof response.data !== "object") throw new MihoyoError("SCHEMA", "社区没有返回有效数据。");
    return response.data;
  }
  get(endpoint, options = {}) { return this.request(endpoint, { ...options, method: "GET" }); }
  post(endpoint, body, options = {}) { return this.request(endpoint, { ...options, method: "POST", body }); }
  async getUserGameRoles(gameBiz = "nap_cn") {
    const data = await this.data("/binding/api/getUserGameRolesByCookie", { scope: "api", server: gameBiz === "nap_cn" ? "prod_gf_cn" : "prod_gf_us", query: { game_biz: gameBiz } });
    if (!Array.isArray(data.list)) throw new MihoyoError("SCHEMA", "角色列表格式异常。");
    return data.list;
  }
  record(type, uid, server = "prod_gf_cn", extra = {}) {
    const spec = RECORDS[type];
    if (!spec) throw new TypeError("Unknown record type");
    const [endpoint, identity, period] = spec;
    const query = { lang: "zh-cn", ...(identity === "role" ? { role_id: uid, server } : { uid, region: server }), ...(period ? { schedule_type: 1 } : {}), ...(type === "hollowDetail" ? { type: 3 } : {}), ...extra };
    return this.data("/event/game_record_zzz/api/zzz/" + endpoint, { server, query });
  }
  getDailyNote(uid, region) { return this.record("note", uid, region); }
  monthly(uid, server, month) { return this.data("/event/nap_ledger/month_info", { scope: "api", server, query: { uid, region: server, ...(month ? { month } : {}) } }); }
  signInfo(uid, server) { return this._sign("info", uid, server); }
  sign(uid, server) { return this._sign("sign", uid, server); }
  _sign(action, uid, server) {
    const overseas = isOverseas(server);
    const query = { act_id: overseas ? "e202406031448091" : "e202406242138391", uid, region: server, lang: "zh-cn" };
    return this.data("/event/luna/zzz/" + action, { scope: "api", server, generation: 1, headers: { "x-rpc-signgame": "zzz" }, ...(action === "sign" ? { method: "POST", body: query } : { query }) });
  }
  async authKey(uid, server) {
    const data = await this.data("/binding/api/genAuthKey", { scope: "api", server, generation: 1, method: "POST", body: { auth_appid: "webview_gacha", game_biz: isOverseas(server) ? "nap_global" : "nap_cn", game_uid: Number(uid), region: server } });
    if (!data.authkey) throw new MihoyoError("AUTHKEY", "无法取得调频授权，请更新登录凭据或私聊提交官方记录链接。");
    return data.authkey;
  }
  gachaPage(uid, server, type, endId = "0", authkey, page = 1) {
    if (!authkey) return this.recordGacha(uid, server, type, endId);
    const host = isOverseas(server) ? "public-operation-nap-sg.hoyoverse.com" : "public-operation-nap.mihoyo.com";
    const baseType=type==="12001"?"102":type==="13001"?"103":String(type)[0];
    return this.data("https://" + host + "/common/gacha_record/api/getGachaLog", { public: true, server, query: { authkey, authkey_ver: 1, sign_type: 2, auth_appid:"webview_gacha", game_biz: isOverseas(server) ? "nap_global" : "nap_cn", gacha_type: type, real_gacha_type:baseType, init_log_gacha_type:type, init_log_gacha_base_type:baseType, page, end_id: endId, size: 20, lang: "zh-cn" } });
  }
  async recordGacha(uid, server, type, endId) {
    const types={"1001":"GACHA_TYPE_PERMANENT","2001":"GACHA_TYPE_CHARACTER_UP","3001":"GACHA_TYPE_WEAPON_UP","5001":"GACHA_TYPE_BANGBOO","12001":"GACHA_TYPE_CHARACTER_RETURN","13001":"GACHA_TYPE_WEAPON_RETURN"};
    if(!types[type])throw new MihoyoError("GACHA_TYPE","不支持该调频类型。");
    const data=await this.data("/event/game_record_zzz/api/zzz/gacha_record", { server, query: { uid, region: server, lang: "zh-cn", gacha_type: types[type], end_id: endId } });
    if(!Array.isArray(data.gacha_item_list))throw new MihoyoError("SCHEMA","官方调频记录格式异常。");
    const list=data.gacha_item_list.map(row=>{
      const d=row.date;
      if(!d || ![d.year,d.month,d.day,d.hour,d.minute,d.second].every(Number.isInteger))throw new MihoyoError("SCHEMA","官方调频时间格式异常。");
      const time=String(d.year)+"-"+String(d.month).padStart(2,"0")+"-"+String(d.day).padStart(2,"0")+" "+String(d.hour).padStart(2,"0")+":"+String(d.minute).padStart(2,"0")+":"+String(d.second).padStart(2,"0");
      return {id:row.id,uid:String(row.uid || data.uid || uid),region:row.region || data.region || server,gacha_type:type,item_id:String(row.item_id || ""),name:row.item_name,item_type:{ITEM_TYPE_WEAPON:"音擎",ITEM_TYPE_AVATAR:"代理人",ITEM_TYPE_BANGBOO:"邦布"}[row.item_type] || row.item_type,rank_type:{B:"2",A:"3",S:"4"}[row.rarity],time,count:"1"};
    });
    return {list};
  }
  async liveCodes() {
    const navigation=await this.data("https://bbs-api.miyoushe.com/apihub/api/home/new",{public:true,query:{gids:8,parts:"1,3,4",version:3}});
    const candidates=(navigation.navigator || []).filter(item=>/前瞻|兑换码|直播/.test(item.name || ""));
    let actId;
    for (const item of candidates) {
      let raw=String(item.app_path || "");
      try {raw=decodeURIComponent(raw);} catch {}
      const matched=/[?&]act_id=([a-zA-Z0-9_-]{1,80})(?:[&#]|$)/.exec(raw);
      if(matched) {actId=matched[1];break;}
    }
    if(!actId) return {codes:[],source:"https://www.miyoushe.com/zzz",title:"暂无官方前瞻兑换码"};
    const options={public:true,headers:{"x-rpc-act_id":actId}};
    const live=await this.data("/event/miyolive/index",{...options,scope:"api"});
    if(!live.live?.code_ver) return {codes:[],title:live.live?.title || "暂无兑换码",source:"https://www.miyoushe.com/zzz"};
    const result=await this.data("https://api-takumi-static.mihoyo.com/event/miyolive/refreshCode",{...options,query:{version:live.live.code_ver,time:Math.floor(Date.now()/1000)}});
    if(!Array.isArray(result.code_list)) throw new MihoyoError("SCHEMA","官方兑换码列表格式异常。");
    return {codes:result.code_list.map(row=>({code:String(row.code || ""),title:String(row.title || ""),expiresAt:row.end_time || row.expire_time})).filter(row=>row.code),title:live.live.title,source:"https://www.miyoushe.com/zzz"};
  }
}
export default MihoyoTakumiClient;
