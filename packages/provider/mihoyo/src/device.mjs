import crypto from "node:crypto";
import os from "node:os";
import { MihoyoError } from "./client.mjs";
import { normalizeAndroidProfile, androidExtFields, androidHeaders } from "./android-profile.mjs";

/** Official, unauthenticated web-device issuance. A random seed is never a fingerprint. */
export async function issueDeviceFingerprint({deviceId,region="prod_gf_cn",mobile,fetchImpl=fetch,signal,timeoutMs=15000,now=Date.now}={}) {
  if(!/^[a-zA-Z0-9._-]{1,128}$/.test(deviceId || "")) throw new TypeError("Invalid device ID");
  const body={
    app_name:region==="prod_gf_cn"?"bbs_cn":"bbs_oversea",device_id:deviceId,platform:"4",
    seed_id:crypto.randomBytes(8).toString("hex"),seed_time:String(now()),
    // Web SDK seed format differs from the 13-character fingerprint returned by the service.
    device_fp:String(crypto.randomInt(1000000000,10000000000)),
    ext_fields:JSON.stringify({userAgent:"Game-Hub/1.0",browserPlat:os.platform(),browserLanguage:"zh-CN",browserTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone})
  };
  const android=mobile?normalizeAndroidProfile(mobile):null;
  if(android) {
    if(region!=="prod_gf_cn")throw new MihoyoError("DEVICE_PROFILE_REGION","Android 设备信息导入目前仅支持国服。");
    body.platform="2";body.device_fp="0000000000000";body.ext_fields=JSON.stringify(androidExtFields(android));
  }
  const timeout=AbortSignal.timeout(timeoutMs);
  try {
    signal?.throwIfAborted();
    const host=region==="prod_gf_cn"?"public-data-api.mihoyo.com":"sg-public-data-api.hoyoverse.com";
    const response=await fetchImpl("https://"+host+"/device-fp/api/getFp",{
      method:"POST",headers:{"Content-Type":"application/json","User-Agent":"Game-Hub/1.0"},
      body:JSON.stringify(body),redirect:"error",signal:signal?AbortSignal.any([signal,timeout]):timeout
    });
    if(!response.ok)throw new MihoyoError("DEVICE_FP_HTTP","官方设备指纹服务暂不可用。");
    const result=await response.json();
    // The API returns retcode=0 and a fallback device_fp even when data.code=403.
    if(result.retcode!==0 || result.data?.code!==200 || typeof result.data?.device_fp!=="string" || !/^[0-9a-f]{13}$/i.test(result.data.device_fp)) throw new MihoyoError("DEVICE_FP_REJECTED","官方未签发有效设备指纹；没有保存随机回退值。");
    return {device_id:deviceId,device_fp:result.data.device_fp,device_fp_source:android?"official-android":"official-web",device_fp_issued_at:now(),...(android?{device_android:android,device_name:androidHeaders(android)["x-rpc-device_name"],device_model:android.deviceModel}:{})};
  } catch(error) {
    if(error instanceof MihoyoError)throw error;
    throw new MihoyoError("DEVICE_FP_UNAVAILABLE","官方设备指纹请求失败；没有保存随机回退值。");
  }
}
