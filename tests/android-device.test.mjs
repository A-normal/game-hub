import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { IdentityVault, GameHubDispatcher, InboundShaper } from "../packages/core/src/index.mjs";
import { MihoyoCommunityProvider, normalizeAndroidProfile } from "../packages/provider/mihoyo/src/index.mjs";
import { issueDeviceFingerprint } from "../packages/provider/mihoyo/src/device.mjs";
import { androidExtFields } from "../packages/provider/mihoyo/src/android-profile.mjs";
import { ZZZPluginManifest } from "../packages/plugin/zzz/src/manifest.mjs";

const mobile={deviceName:"test-device",deviceBoard:"test-board",deviceModel:"Test  Model",oaid:"test-oaid-private",androidVersion:"15",deviceFingerprint:"Test/test-product/test-device:15/BUILD/123:user/release-keys",deviceProduct:"test-product"};
const owner="mock:1", role={uid:"17708598",region:"prod_gf_cn",nickname:"test",level:60};
const original={device_id:"stable-device",device_fp:"0123456789abc"};
const response=()=>new Response(JSON.stringify({retcode:0,data:{code:200,device_fp:"123456789abcd"}}));
function setup(t,fetchImpl=async()=>response()) {
  const vault=new IdentityVault();t.after(()=>vault.close());
  vault.saveAccountBinding({unifiedUserId:owner,platform:"mock",originalId:"1",providerId:"mihoyo",accountKey:"100",gameId:"zzz",cookies:{ck:"ltuid=100;cookie_token=test"},device:original,roles:[role]});
  const d=new GameHubDispatcher({vault});d.registerProvider(new MihoyoCommunityProvider({fetchImpl}));d.registerPlugin(ZZZPluginManifest);
  d.setNamespace("zzz",{prefix:"&",aliases:[]});const replies=[];
  const run=(text,extra={})=>d.dispatch({cleanText:text,unifiedUserId:owner,platform:"mock",sender:{id:"1"},reply:async v=>replies.push(String(v)),...extra});
  return {vault,run,replies};
}
test("Android issuance maps imported hardware fields and requires a genuine issued fingerprint",async()=>{
  let sent;
  const issued=await issueDeviceFingerprint({deviceId:"stable",mobile:{...mobile,cookie:"ignored-secret"},fetchImpl:async(url,init)=>{sent={url,init,body:JSON.parse(init.body)};return response();}});
  assert.equal(sent.body.platform,"2");assert.equal(sent.body.device_fp,"0000000000000");assert.equal(sent.init.headers.Cookie,undefined);assert.equal(sent.init.headers.DS,undefined);
  const ext=JSON.parse(sent.body.ext_fields);
  for(const [field,value] of Object.entries({deviceName:mobile.deviceName,productName:mobile.deviceProduct,model:mobile.deviceModel,brand:"Test",manufacturer:"Test",osVersion:"15",board:mobile.deviceBoard,oaid:mobile.oaid,deviceInfo:mobile.deviceFingerprint,buildType:"user",buildTags:"release-keys"}))assert.equal(ext[field],value,field);
  assert.ok(!sent.init.body.includes("ignored-secret"));assert.deepEqual(issued.device_android,mobile);assert.equal(issued.device_fp_source,"official-android");
  await assert.rejects(issueDeviceFingerprint({deviceId:"stable",mobile,region:"prod_gf_us"}),{code:"DEVICE_PROFILE_REGION"});
  await assert.rejects(issueDeviceFingerprint({deviceId:"stable",mobile,fetchImpl:async()=>new Response(JSON.stringify({retcode:0,data:{code:403,device_fp:"123456789abcd"}}))}),{code:"DEVICE_FP_REJECTED"});
});
test("Android validation rejects malformed, unbounded and injected fields without echoing values",()=>{
  for(const bad of [null,[],{}, {...mobile,deviceModel:"SECRET\r\nInjected: x"},{...mobile,oaid:"x".repeat(129)},{...mobile,androidVersion:"999"}])assert.throws(()=>normalizeAndroidProfile(bad),error=>!error.message.includes("SECRET"));
  assert.deepEqual(normalizeAndroidProfile({...mobile,unknown:"ignored"}),mobile);
  assert.equal(androidExtFields(mobile).packageVersion,"2.104.0");
});
test("private JSON import, refresh and authenticated requests retain one Android profile; public requests omit it",async t=>{
  const requests=[];const h=setup(t,async(url,init)=>{requests.push({url,init});return response();});
  assert.equal((await h.run("&绑定设备 "+JSON.stringify({...mobile,ignored:"secret"},null,2))).status,"HANDLED");
  let current=h.vault.getActiveRole(owner,"zzz");assert.deepEqual(current.device.device_android,mobile);assert.equal(current.device.device_id,original.device_id);
  assert.ok(!h.replies.at(-1).includes(mobile.oaid));assert.match(h.replies.at(-1),/&便签/);
  await h.run("&默认设备 刷新指纹");assert.equal(JSON.parse(requests.at(-1).init.body).platform,"2");
  current=h.vault.getActiveRole(owner,"zzz");const provider=new MihoyoCommunityProvider({fetchImpl:async(url,init)=>{requests.push({url,init});return new Response(JSON.stringify({retcode:0,data:{}}));}});
  const client=provider.createClient(current.cookies,current.device);await client.getDailyNote(role.uid,role.region);
  const headers=requests.at(-1).init.headers;assert.equal(headers["x-rpc-device_id"],original.device_id);assert.equal(headers["x-rpc-device_fp"],"123456789abcd");assert.equal(headers["x-rpc-device_model"],mobile.deviceModel);assert.equal(headers["x-rpc-sys_version"],"15");assert.equal(headers["x-rpc-client_type"],"2");assert.match(headers["User-Agent"],/Android 15/);
  await client.request("https://bbs-api.miyoushe.com/apihub/api/home/new",{public:true});const publicHeaders=requests.at(-1).init.headers;
  assert.equal(publicHeaders.Cookie,undefined);assert.equal(publicHeaders.DS,undefined);assert.equal(publicHeaders["x-rpc-device_model"],undefined);assert.equal(publicHeaders["User-Agent"],"Game-Hub/1.0");
});
test("group, malformed JSON and failed issuance cannot modify the device or leak imported data",async t=>{
  let calls=0;const h=setup(t,async()=>{calls++;throw new Error("network");});
  assert.equal((await h.run("&绑定设备 "+JSON.stringify(mobile),{isGroup:true})).status,"DENIED");
  for(const json of ["{bad",JSON.stringify({...mobile,oaid:"x".repeat(9000)}),JSON.stringify({...mobile,deviceModel:"injected\r\nvalue"})])assert.equal((await h.run("&绑定设备 "+json)).status,"FAILED");
  assert.equal(calls,0);
  assert.equal((await h.run("&绑定设备 "+JSON.stringify(mobile))).status,"FAILED");assert.equal(calls,1);
  assert.deepEqual(h.vault.getActiveRole(owner,"zzz").device,original);assert.ok(!h.replies.join("\n").includes(mobile.oaid));
  await h.run('&绑定设备 {"device_id":"manual-device","device_fp":"123456789abcd","oaid":"ignored"}');
  assert.equal(calls,1);assert.equal(h.vault.getActiveRole(owner,"zzz").device.device_fp_source,"manual");assert.equal(h.vault.getActiveRole(owner,"zzz").device.oaid,undefined);
});
test("issuance preserves concurrently refreshed cookies and refuses unbind or device races",async t=>{
  for(const change of ["cookie","unbind","device"]) {
    let entered,release;const started=new Promise(r=>entered=r),waiting=new Promise(r=>release=r);
    const h=setup(t,async()=>{entered();await waiting;return response();});
    const pending=h.run("&绑定设备 "+JSON.stringify(mobile));await started;
    if(change==="unbind")h.vault.unbindUser(owner,"mihoyo","100");
    else h.vault.saveCredential("mihoyo","100",{ck:"new-cookie"},change==="device"?{device_id:"new-device"}:original);
    release();const result=await pending;
    if(change==="cookie"){assert.equal(result.status,"HANDLED");assert.equal(h.vault.getActiveRole(owner,"zzz").cookies.ck,"new-cookie");}
    else {assert.equal(result.status,"FAILED");assert.equal(h.vault.getUserCredential(owner,"mihoyo","100")?.device.device_id,change==="device"?"new-device":undefined);}
  }
});
test("device metadata is encrypted, survives reopening, reads legacy plaintext and fails closed on corruption",()=>{
  const path=fileURLToPath(new URL("./_tmp_android_"+randomUUID()+".db",import.meta.url));let vault;
  try {
    vault=new IdentityVault(path);vault.saveAccountBinding({unifiedUserId:owner,platform:"mock",originalId:"1",providerId:"mihoyo",accountKey:"100",gameId:"zzz",cookies:{ck:"test"},device:{...original,device_android:mobile},roles:[role]});
    const raw=vault.db.prepare("SELECT device_meta FROM community_credentials").get().device_meta;assert.match(raw,/^enc:v1:/);assert.ok(!raw.includes(mobile.oaid));vault.close();vault=new IdentityVault(path);
    assert.deepEqual(vault.getUserCredential(owner,"mihoyo","100").device.device_android,mobile);
    vault.db.prepare("UPDATE community_credentials SET device_meta=?").run(JSON.stringify(original));assert.deepEqual(vault.getActiveRole(owner,"zzz").device,original);
    vault.db.prepare("UPDATE community_credentials SET device_meta=?").run("enc:v1:broken");assert.throws(()=>vault.getActiveRole(owner,"zzz"),{code:"VAULT_DECRYPT"});assert.throws(()=>vault.getUserCredential(owner,"mihoyo","100"),{code:"VAULT_DECRYPT"});
  } finally {vault?.close();unlinkSync(path);}
});
test("device input is redacted from command and structured logs; vendored source hashes match",()=>{
  for(const text of ["&绑定设备 "+JSON.stringify(mobile),JSON.stringify({device_android:mobile}),"device_android: "+JSON.stringify(mobile)]) {
    const safe=InboundShaper.sanitizeLogText(text);assert.ok(!safe.includes(mobile.oaid));assert.ok(!safe.includes(mobile.deviceFingerprint));assert.ok(!safe.includes(mobile.deviceModel));
  }
  const root=new URL("../packages/provider/mihoyo/vendor/android-device/",import.meta.url),manifest=JSON.parse(readFileSync(new URL("manifest.json",root),"utf8"));
  for(const [name,hash] of Object.entries(manifest.files))assert.equal(createHash("sha256").update(readFileSync(new URL(name,root))).digest("hex"),hash,name);
});
