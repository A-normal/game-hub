/**
 * Foreground, bounded official-account acceptance. Registration changes the
 * official account's device records; obtain explicit authorization before use.
 * Production SQLite is read-only. Candidate device state exists only in memory.
 * DIAG_DEVICE_PROFILE_SHA256 is SHA256(JSON.stringify(sorted seven-field entries)).
 * Never pass a Cookie/token on a command line or log response/request payloads.
 */
import crypto from "node:crypto";
import { IdentityVault } from "../packages/core/src/identity/vault.mjs";
import { normalizeAndroidProfile, prepareAndroidDevice, MihoyoTakumiClient } from "../packages/provider/mihoyo/src/index.mjs";

if(process.env.DIAG_ALLOW_OFFICIAL_DEVICE_REGISTRATION!=="1" || !/^[0-9a-f]{64}$/.test(process.env.DIAG_DEVICE_PROFILE_SHA256 || "")) {
  throw new Error("Explicit official registration authorization and an exact private profile hash are required.");
}
const out=value=>console.log(JSON.stringify(value));
const budgets=new Map([
  ["https://public-data-api.mihoyo.com/device-fp/api/getFp","POST"],
  ["https://bbs-api.miyoushe.com/apihub/api/deviceLogin","POST"],
  ["https://bbs-api.miyoushe.com/apihub/api/saveDevice","POST"],
  ["https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie","GET"],
  ["https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz/note","GET"]
]);
const attempted=new Set();
const boundedFetch=async(url,init)=>{
  const parsed=new URL(url),key=parsed.origin+parsed.pathname;
  if(budgets.get(key)!==init.method || attempted.has(key) || init.redirect!=="error")throw Object.assign(new Error("DIAG_BUDGET"),{code:"DIAG_BUDGET"});
  attempted.add(key);
  const response=await fetch(url,init);
  out({stage:parsed.pathname.split("/").at(-1),httpStatus:response.status});
  return response;
};
const vault=new IdentityVault(process.env.DIAG_DB || "/app/data/vault.db",{readOnly:true});
try {
  vault.db.exec("PRAGMA query_only=ON");
  const matches=[];
  for(const row of vault.db.prepare("SELECT provider_id,account_key,device_meta FROM community_credentials WHERE provider_id=?").all("mihoyo")) {
    let device;
    try {
      device=JSON.parse(vault._decryptCredential(row.device_meta));
      const profile=normalizeAndroidProfile(device.device_android);
      const hash=crypto.createHash("sha256").update(JSON.stringify(Object.entries(profile).sort(([a],[b])=>a.localeCompare(b)))).digest("hex");
      if(hash===process.env.DIAG_DEVICE_PROFILE_SHA256)matches.push({...row,device});
    } catch { /* Unrelated profiles are never printed, queried or modified. */ }
  }
  if(matches.length!==1)throw new Error("DIAG_TARGET_NOT_UNIQUE");
  const target=matches[0];
  const roles=vault.db.prepare("SELECT uid,region FROM game_roles WHERE provider_id=? AND account_key=? AND game_id=?").all(target.provider_id,target.account_key,"zzz");
  if(roles.length!==1 || roles[0].region!=="prod_gf_cn")throw new Error("DIAG_ROLE_NOT_UNIQUE_CN");
  const raw=vault._decryptCredential(vault.db.prepare("SELECT cookies_json FROM community_credentials WHERE provider_id=? AND account_key=?").get(target.provider_id,target.account_key).cookies_json);
  let cookies;try{cookies=JSON.parse(raw);}catch{cookies={ck:raw};}
  if(typeof cookies==="string")cookies={ck:cookies};
  const sourceSnapshot=target.device_meta;
  const currentCookies=()=>{
    const latest=vault.db.prepare("SELECT device_meta FROM community_credentials WHERE provider_id=? AND account_key=?").get(target.provider_id,target.account_key);
    if(!latest || latest.device_meta!==sourceSnapshot)throw Object.assign(new Error("DEVICE_CHANGED"),{code:"DEVICE_CHANGED"});
    return cookies;
  };
  let candidate=target.device,prepared=false;
  try {
    candidate=await prepareAndroidDevice({deviceId:candidate.device_id,deviceFp:candidate.device_fp,mobile:candidate.device_android,cookies,region:roles[0].region,fetchImpl:boundedFetch,timeoutMs:8000,currentCookies});
    prepared=true;out({stage:"prepared",registration:candidate.device_registration});
  } catch(error) {out({stage:"prepare",code:error.code || "FAILED"});}
  const client=new MihoyoTakumiClient(cookies,candidate,{fetchImpl:boundedFetch,timeoutMs:8000});
  let noteSuccess=false;
  for(const [stage,endpoint,options]of [
    ["roles","/binding/api/getUserGameRolesByCookie",{scope:"api",query:{game_biz:"nap_cn"}}],
    ["note","/event/game_record_zzz/api/zzz/note",{query:{role_id:roles[0].uid,server:roles[0].region}}]
  ]) {
    try {
      currentCookies();const response=await client.request(endpoint,options);
      out({stage,retcode:response.retcode,prepared});
      if(stage==="note")noteSuccess=response.retcode===0;
    } catch(error) {out({stage,code:error.code || "FAILED"});}
  }
  const registered=prepared && candidate.device_registration.login.status==="ok" && candidate.device_registration.save.status==="ok";
  out({stage:"summary",prepared,registered,noteSuccess,requests:attempted.size,persistenceWrites:0});
  if(!prepared || !registered || !noteSuccess)process.exitCode=1;
} finally {vault.close();}
