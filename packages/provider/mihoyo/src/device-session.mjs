import crypto from "node:crypto";
import { issueDeviceFingerprint } from "./device.mjs";
import { MihoyoTakumiClient } from "./client.mjs";
import { MihoyoError } from "./errors.mjs";
import { androidExtFields, ANDROID_APP_VERSION, normalizeAndroidProfile } from "./android-profile.mjs";

export const ANDROID_FINGERPRINT_TTL_MS=7*86400000;
const retryDelayMs=5*60000;
export const deviceChanged=()=>new MihoyoError("DEVICE_CHANGED","账号绑定或设备配置已变化，本次设备操作已停止，请重试。");

/** Official account-side registration. Results contain codes only, never payloads. */
export async function registerAndroidDevice({cookies,device,fetchImpl=fetch,signal,timeoutMs=15000,now=Date.now,currentCookies=()=>cookies}={}) {
  const mobile=normalizeAndroidProfile(device.device_android);
  const registrationId=device.device_registration_id || crypto.randomBytes(16).toString("hex").slice(0,19);
  const body={app_version:ANDROID_APP_VERSION,device_id:device.device_id,device_name:mobile.deviceFingerprint.split("/")[0]+mobile.deviceModel,
    os_version:androidExtFields(mobile).sdkVersion,platform:"Android",registration_id:registrationId};
  const results={version:1,attempted_at:now()};
  for(const [name,path]of [["login","deviceLogin"],["save","saveDevice"]]) {
    signal?.throwIfAborted();
    const latest=currentCookies(); // The owner must still have this exact device binding.
    const client=new MihoyoTakumiClient(latest,device,{fetchImpl,timeoutMs});
    try {
      const response=await client.request("https://bbs-api.miyoushe.com/apihub/api/"+path,{method:"POST",body,signal});
      results[name]={status:response.retcode===0?"ok":"rejected",retcode:response.retcode};
    } catch(error) {
      if(signal?.aborted || error.code==="DEVICE_CHANGED")throw error;
      results[name]={status:"error",code:["HTTP","TIMEOUT","NETWORK","SCHEMA"].includes(error.code)?error.code:"FAILED"};
    }
    signal?.throwIfAborted();
    currentCookies(); // Stop before the next side effect after unbind or device replacement.
  }
  return {...device,device_registration_id:registrationId,device_registration:results};
}

/** Build an in-memory candidate; persistence belongs to the caller's scoped store. */
export async function prepareAndroidDevice({deviceId,deviceFp,mobile,cookies,region="prod_gf_cn",fetchImpl=fetch,timeoutMs=15000,signal,now=Date.now,currentCookies=()=>cookies}={}) {
  signal?.throwIfAborted();
  const issued=await issueDeviceFingerprint({deviceId,deviceFp,mobile,cookies:currentCookies(),region,fetchImpl,timeoutMs,signal,now});
  signal?.throwIfAborted();currentCookies();
  return registerAndroidDevice({cookies,device:issued,fetchImpl,timeoutMs,signal,now,currentCookies});
}

/** No timers: renewal is awaited by an authenticated request, coalesced per account. */
export class AndroidDeviceLifecycle {
  constructor(options={}) {this.options=options;this.pending=new Map();this.failures=new Map();}
  async current(store,{server,signal}={}) {
    const read=()=>{const value=store.read();if(!value)throw deviceChanged();return value;};
    signal?.throwIfAborted();
    const initial=read(), now=this.options.now || Date.now;
    const needsRenewal=value=>server==="prod_gf_cn" && value.device.device_android && value.device.device_fp_source==="official-android" &&
      (!value.device.device_fp || !Number.isFinite(value.device.device_fp_issued_at) || now()-value.device.device_fp_issued_at>=ANDROID_FINGERPRINT_TTL_MS || !value.device.device_registration?.version);
    if(!needsRenewal(initial))return initial;
    if(this.pending.has(store.key)) {await this.pending.get(store.key);signal?.throwIfAborted();return read();}
    const previous=this.failures.get(store.key);
    if(previous && previous.device===JSON.stringify(initial.device) && previous.until>now())throw new MihoyoError(previous.code,"设备指纹更新暂未完成，请稍后重试；已有设备配置已保留。");
    const pending=(async()=>{
      const expected=read();if(!needsRenewal(expected))return;
      const snapshot=JSON.stringify(expected.device);
      const currentCookies=()=>{signal?.throwIfAborted();const latest=read();if(JSON.stringify(latest.device)!==snapshot)throw deviceChanged();return latest.cookies;};
      const candidate=await prepareAndroidDevice({deviceId:expected.device.device_id,deviceFp:expected.device.device_fp,mobile:expected.device.device_android,
        cookies:expected.cookies,region:server,fetchImpl:this.options.fetchImpl,timeoutMs:this.options.timeoutMs,signal,now,currentCookies});
      currentCookies();
      store.write(expected,candidate);
      this.failures.delete(store.key);
    })();
    this.pending.set(store.key,pending);
    try {await pending;signal?.throwIfAborted();return read();}
    catch(error) {
      if(error.code!=="DEVICE_CHANGED" && !signal?.aborted)this.failures.set(store.key,{device:JSON.stringify(initial.device),until:now()+retryDelayMs,code:error instanceof MihoyoError?error.code:"DEVICE_FP_UNAVAILABLE"});
      throw error;
    } finally {this.pending.delete(store.key);}
  }
}
