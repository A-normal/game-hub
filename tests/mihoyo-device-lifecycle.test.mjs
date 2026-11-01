import test from "node:test";
import assert from "node:assert/strict";
import { IdentityVault, GameHubDispatcher } from "../packages/core/src/index.mjs";
import { MihoyoCommunityProvider, prepareAndroidDevice, ANDROID_FINGERPRINT_TTL_MS } from "../packages/provider/mihoyo/src/index.mjs";
import { MihoyoTakumiClient } from "../packages/provider/mihoyo/src/client.mjs";
import { ZZZPluginManifest } from "../packages/plugin/zzz/src/manifest.mjs";
import { accountDeviceStore, createAccountClient } from "../packages/plugin/zzz/src/account-client.mjs";

const mobile={deviceName:"device",deviceBoard:"board",deviceModel:"Fixture Model",oaid:"private-fixture-oaid",androidVersion:"15",deviceFingerprint:"Fixture/product/device:15/BUILD.15/123:user/release-keys",deviceProduct:"product"};
const old={device_id:"stable-account-device",device_fp:"0123456789abc",device_fp_source:"official-android",device_fp_issued_at:1,device_android:mobile};
const issuedFp="123456789abcd", owner="mock:1", role={uid:"12345678",region:"prod_gf_cn",nickname:"fixture"};
const api=(data={},retcode=0)=>new Response(JSON.stringify({retcode,data}));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(t,options={}) {
  const vault=new IdentityVault();t.after(()=>vault.close());
  vault.saveAccountBinding({unifiedUserId:owner,platform:"mock",originalId:"1",providerId:"mihoyo",accountKey:"100",gameId:"zzz",cookies:{ck:"ltuid=100;cookie_token=fixture-private"},device:old,roles:[role]});
  const calls=[];
  const provider=new MihoyoCommunityProvider({now:()=>ANDROID_FINGERPRINT_TTL_MS+100,...options,fetchImpl:async(url,init)=>{
    calls.push({url,init});return options.fetchImpl?options.fetchImpl(url,init):url.includes("/device-fp/")?api({code:200,device_fp:issuedFp}):api({energy:{progress:{current:1,max:240}}});
  }});
  const store=accountDeviceStore({vault,owner,accountKey:"100"});
  const client=()=>createAccountClient({provider,vault,owner,accountKey:"100"});
  return {vault,provider,store,calls,client};
}

test("Android import performs signed registration and reports each result without pretending rejection succeeded",async()=>{
  const calls=[];
  const device=await prepareAndroidDevice({deviceId:old.device_id,deviceFp:old.device_fp,mobile,cookies:{ck:"private-cookie"},now:()=>42,fetchImpl:async(url,init)=>{
    calls.push({url,init});return url.includes("/device-fp/")?api({code:200,device_fp:issuedFp}):api({},url.endsWith("deviceLogin")?10041:0);
  }});
  assert.deepEqual(calls.map(c=>new URL(c.url).pathname),["/device-fp/api/getFp","/apihub/api/deviceLogin","/apihub/api/saveDevice"]);
  assert.deepEqual(device.device_registration,{version:1,attempted_at:42,login:{status:"rejected",retcode:10041},save:{status:"ok",retcode:0}});
  for(const {init}of calls){assert.equal(init.headers.Cookie,"private-cookie");assert.equal(init.headers["x-rpc-device_id"],old.device_id);assert.equal(init.headers["x-rpc-app_version"],"2.73.1");assert.equal(init.headers["x-rpc-csm_source"],"myself");assert.match(init.headers["User-Agent"],/Fixture Model Build\/BUILD\.15/);assert.equal(init.redirect,"error");}
  assert.equal(calls[0].init.headers.DS,undefined);
  for(const {init}of calls.slice(1)) {
    assert.equal(init.headers["x-rpc-device_fp"],issuedFp);assert.ok(init.headers.DS);
    const b=JSON.parse(init.body);assert.equal(b.device_id,old.device_id);assert.equal(b.os_version,"35");assert.equal(b.platform,"Android");assert.equal(b.registration_id,device.device_registration_id);assert.equal(b.app_version,init.headers["x-rpc-app_version"]);
  }
  assert.ok(!JSON.stringify(device.device_registration).includes("private"));
});

test("request-time renewal coalesces concurrent queries, persists one candidate and uses it immediately",async t=>{
  const h=setup(t);
  await Promise.all([h.client().getDailyNote(role.uid,role.region),h.client().getDailyNote(role.uid,role.region)]);
  assert.equal(h.calls.filter(c=>c.url.includes("/device-fp/")).length,1);assert.equal(h.calls.filter(c=>c.url.endsWith("deviceLogin")).length,1);assert.equal(h.calls.filter(c=>c.url.endsWith("saveDevice")).length,1);
  const notes=h.calls.filter(c=>c.url.includes("/zzz/note"));assert.equal(notes.length,2);
  for(const {init}of notes)assert.equal(init.headers["x-rpc-device_fp"],issuedFp);
  const saved=h.store.read();assert.equal(saved.device.device_fp,issuedFp);assert.deepEqual(saved.device.device_android,mobile);assert.equal(saved.device.device_id,old.device_id);
  await h.client().getDailyNote(role.uid,role.region);assert.equal(h.calls.length,6,"fresh queries do not register again");
  await h.client().request("https://bbs-api.miyoushe.com/apihub/api/home/new",{public:true});assert.equal(h.calls.at(-1).init.headers.Cookie,undefined);
});

test("manual fingerprints, overseas profiles and public requests never trigger device renewal",async t=>{
  const h=setup(t);
  h.vault.saveCredential("mihoyo","100",{ck:"cookie"},{...old,device_fp_source:"manual"});
  await h.client().getDailyNote(role.uid,role.region);
  h.vault.saveCredential("mihoyo","100",{ck:"cookie"},old);
  await h.client().getDailyNote("1000123456","prod_gf_us");
  await h.client().request("https://bbs-api.miyoushe.com/apihub/api/home/new",{public:true});
  assert.equal(h.calls.length,3);assert.ok(h.calls.every(c=>!c.url.includes("/device-fp/")));
});

test("seven-day expiry is enforced at the boundary and a fresh legacy profile is upgraded once",async t=>{
  let now=100;const h=setup(t,{now:()=>now});
  const device={...old,device_fp_issued_at:100,device_registration:{version:1,login:{status:"ok"},save:{status:"ok"}}};
  h.vault.saveCredential("mihoyo","100",{ck:"cookie"},device);
  now=100+ANDROID_FINGERPRINT_TTL_MS-1;await h.client().getDailyNote(role.uid,role.region);assert.equal(h.calls.length,1);
  now++;await h.client().getDailyNote(role.uid,role.region);assert.equal(h.calls.length,5);
  const legacy={...h.store.read().device};delete legacy.device_registration;
  h.vault.saveCredential("mihoyo","100",{ck:"cookie"},legacy);
  await h.client().getDailyNote(role.uid,role.region);assert.equal(h.calls.length,9);
});

test("failed issuance retains the old device and has a request-time cooldown instead of repeated calls",async t=>{
  const h=setup(t,{fetchImpl:async()=>api({code:403,device_fp:issuedFp})});
  await assert.rejects(h.client().getDailyNote(role.uid,role.region),{code:"DEVICE_FP_REJECTED"});
  await assert.rejects(h.client().getDailyNote(role.uid,role.region),{code:"DEVICE_FP_REJECTED"});
  assert.equal(h.calls.length,1);assert.deepEqual(h.store.read().device,old);
});

test("registration HTTP/schema failures remain visible and do not cause registration loops",async t=>{
  const h=setup(t,{fetchImpl:async url=>url.includes("/device-fp/")?api({code:200,device_fp:issuedFp}):url.endsWith("deviceLogin")?new Response("bad",{status:503}):url.endsWith("saveDevice")?new Response("bad"):api({})});
  await h.client().getDailyNote(role.uid,role.region);
  assert.deepEqual(h.store.read().device.device_registration.login,{status:"error",code:"HTTP"});
  assert.deepEqual(h.store.read().device.device_registration.save,{status:"error",code:"SCHEMA"});
  await h.client().getDailyNote(role.uid,role.region);assert.equal(h.calls.length,5);
});

test("registration timeout is reported separately and still attempts the independent save step once",async()=>{
  const calls=[];
  const device=await prepareAndroidDevice({deviceId:old.device_id,mobile,cookies:{ck:"fixture"},timeoutMs:5,fetchImpl:async(url,{signal})=>{
    calls.push(url);
    if(url.includes("/device-fp/"))return api({code:200,device_fp:issuedFp});
    if(url.endsWith("deviceLogin"))return new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));
    return api({});
  }});
  assert.deepEqual(device.device_registration.login,{status:"error",code:"TIMEOUT"});assert.equal(device.device_registration.save.status,"ok");assert.equal(calls.length,3);
});

test("unbinding or replacing a device during each network stage stops subsequent requests and writes",async t=>{
  for(const stage of ["/device-fp/","deviceLogin","saveDevice"])for(const action of ["unbind","device"]){
    const entered=deferred(),release=deferred();
    const h=setup(t,{fetchImpl:async url=>{if(url.includes(stage)){entered.resolve();await release.promise;}return url.includes("/device-fp/")?api({code:200,device_fp:issuedFp}):api({});}});
    const pending=h.client().getDailyNote(role.uid,role.region);await entered.promise;
    if(action==="unbind")h.vault.unbindUser(owner,"mihoyo","100");else h.vault.saveCredential("mihoyo","100",{ck:"new-cookie"},{device_id:"replacement-device"});
    release.resolve();await assert.rejects(pending,{code:"DEVICE_CHANGED"});
    assert.equal(h.calls.length,["/device-fp/","deviceLogin","saveDevice"].indexOf(stage)+1);
    assert.equal(h.store.read()?.device.device_id,action==="unbind"?undefined:"replacement-device");
  }
});

test("concurrent Cookie refresh is preserved and its credentials are used for subsequent registration",async t=>{
  const entered=deferred(),release=deferred();const h=setup(t,{fetchImpl:async url=>{if(url.includes("/device-fp/")){entered.resolve();await release.promise;return api({code:200,device_fp:issuedFp});}return api({});}});
  const pending=h.client().getDailyNote(role.uid,role.region);await entered.promise;
  h.vault.saveCredential("mihoyo","100",{ck:"renewed-private-cookie"},old);release.resolve();await pending;
  assert.equal(h.store.read().cookies.ck,"renewed-private-cookie");for(const {init}of h.calls.slice(1))assert.equal(init.headers.Cookie,"renewed-private-cookie");
});

test("aborting during fingerprint issuance cannot register, persist or query afterwards",async t=>{
  const entered=deferred(),release=deferred();const h=setup(t,{fetchImpl:async()=>{entered.resolve();await release.promise;return api({code:200,device_fp:issuedFp});}});
  const controller=new AbortController(),pending=h.client().data("/event/game_record_zzz/api/zzz/note",{signal:controller.signal});
  await entered.promise;controller.abort();release.resolve();await assert.rejects(pending);assert.equal(h.calls.length,1);assert.deepEqual(h.store.read().device,old);
});

test("different accounts never share renewal and revoked owners cannot use another owner's singleflight",async t=>{
  const h=setup(t);
  h.vault.saveAccountBinding({unifiedUserId:"mock:2",platform:"mock",originalId:"2",providerId:"mihoyo",accountKey:"200",gameId:"zzz",cookies:{ck:"other-private-cookie"},device:{...old,device_id:"other-device"},roles:[{...role,uid:"87654321"}]});
  const other=createAccountClient({provider:h.provider,vault:h.vault,owner:"mock:2",accountKey:"200"});
  await Promise.all([h.client().getDailyNote(role.uid,role.region),other.getDailyNote("87654321",role.region)]);
  const fp=h.calls.filter(c=>c.url.includes("/device-fp/"));assert.equal(fp.length,2);
  assert.deepEqual(new Set(fp.map(c=>c.init.headers["x-rpc-device_id"])),new Set([old.device_id,"other-device"]));
  h.vault.unbindUser(owner,"mihoyo","100");assert.throws(()=>h.client(),{code:"DEVICE_CHANGED"});
});

test("scoped default cancellation stops an awaiting registration before save and persistence",async t=>{
  const entered=deferred(),release=deferred();const h=setup(t,{fetchImpl:async url=>{if(url.endsWith("deviceLogin")){entered.resolve();await release.promise;}return url.includes("/device-fp/")?api({code:200,device_fp:issuedFp}):api({});}});
  const controller=new AbortController();
  const c=createAccountClient({provider:h.provider,vault:h.vault,owner,accountKey:"100",signal:controller.signal});
  const pending=c.getDailyNote(role.uid,role.region);await entered.promise;controller.abort();release.resolve();
  await assert.rejects(pending);assert.equal(h.calls.length,2);assert.deepEqual(h.store.read().device,old);
});

test("dispatcher account scope uses the managed lifecycle and accurately shows partial registration",async t=>{
  const h=setup(t,{fetchImpl:async url=>url.includes("/device-fp/")?api({code:200,device_fp:issuedFp}):api({},url.endsWith("deviceLogin")?10041:0)});
  const d=new GameHubDispatcher({vault:h.vault});d.registerProvider(h.provider);d.registerPlugin(ZZZPluginManifest);d.setNamespace("zzz",{prefix:"&",aliases:[]});const replies=[];
  const run=text=>d.dispatch({cleanText:text,unifiedUserId:owner,platform:"mock",sender:{id:"1"},reply:async v=>replies.push(String(v))});
  assert.equal((await run("&绑定设备 "+JSON.stringify(mobile))).status,"HANDLED");
  assert.match(replies.at(-1),/被拒绝（10041）/);assert.match(replies.at(-1),/账号侧设备保存：成功/);assert.ok(!replies.at(-1).includes(mobile.oaid));
  await run("&便签");assert.equal(h.calls.filter(c=>c.url.includes("/device-fp/")).length,1);
});

test("10041 feedback distinguishes successful registration from rejected business acceptance",async t=>{
  const h=setup(t,{fetchImpl:async url=>url.includes("/device-fp/")?api({code:200,device_fp:issuedFp}):api({},url.includes("/zzz/note")?10041:0)});
  const d=new GameHubDispatcher({vault:h.vault});d.registerProvider(h.provider);d.registerPlugin(ZZZPluginManifest);d.setNamespace("zzz",{prefix:"&",aliases:[]});const replies=[];
  const result=await d.dispatch({cleanText:"&便签",unifiedUserId:owner,platform:"mock",sender:{id:"1"},reply:async v=>replies.push(String(v))});
  assert.equal(result.status,"FAILED");assert.match(replies.at(-1),/账号侧设备登录：成功/);assert.match(replies.at(-1),/设备登记结果不代表业务校验通过/);assert.match(replies.at(-1),/&绑定设备/);assert.ok(!replies.at(-1).includes(mobile.oaid));
});

test("unbind after verified completion prevents a retry rather than masking the changed binding",async t=>{
  let h;h=setup(t,{fetchImpl:async url=>url.includes("/device-fp/")?api({code:200,device_fp:issuedFp}):api({},url.includes("/zzz/note")?10041:0),verificationHandler:async()=>{h.vault.unbindUser(owner,"mihoyo","100");return true;}});
  await assert.rejects(h.client().getDailyNote(role.uid,role.region),{code:"DEVICE_CHANGED"});assert.equal(h.calls.length,4);assert.equal(h.store.read(),null);
});

test("verification callback runs once, requires true, never retries a write/public call and exposes only structured failure",async()=>{
  for(const code of [1034,10035,10041]) {
    let requests=0,handled=0;
    const client=new MihoyoTakumiClient("private-cookie",old,{fetchImpl:async()=>{requests++;return api({challenge:"private-challenge"},code);},verificationHandler:async context=>{handled++;assert.equal(context.retcode,code);assert.equal(context.cookies,undefined);return true;}});
    await assert.rejects(client.getDailyNote(role.uid,role.region),e=>e.retcode===code && e.verification.challengePresent && !e.message.includes("private"));assert.equal(requests,2);assert.equal(handled,1);
    requests=handled=0;await assert.rejects(client.data("/event/luna/zzz/sign",{method:"POST",body:{}}));assert.equal(requests,1);assert.equal(handled,0);
    requests=handled=0;await assert.rejects(client.data("https://bbs-api.miyoushe.com/apihub/api/home/new",{public:true}));assert.equal(requests,1);assert.equal(handled,0);
  }
  for(const result of [false,undefined,{verified:true}]) {
    let calls=0;const client=new MihoyoTakumiClient("fixture",{}, {fetchImpl:async()=>{calls++;return api({},10041);},verificationHandler:async()=>result});await assert.rejects(client.getDailyNote("1","prod_gf_cn"));assert.equal(calls,1);
  }
});

test("verified completion can retry a read successfully; handler exceptions and timeout stay private",async()=>{
  let calls=0;const client=new MihoyoTakumiClient("fixture",{}, {fetchImpl:async()=>++calls===1?api({},10041):api({ok:true}),verificationHandler:async()=>true});assert.deepEqual(await client.getDailyNote("1","prod_gf_cn"),{ok:true});assert.equal(calls,2);
  for(const verificationHandler of [async()=>{throw Error("private-token");},async()=>new Promise(()=>{})]) {
    let count=0;const c=new MihoyoTakumiClient("fixture",{}, {timeoutMs:10,fetchImpl:async()=>{count++;return api({},10041);},verificationHandler});
    // Keep the test event loop alive independently of AbortSignal.timeout's unref'ed timer.
    const keepAlive=setTimeout(()=>{},100);
    try{await assert.rejects(c.getDailyNote("1","prod_gf_cn"),e=>e.retcode===10041 && !e.message.includes("private-token"));assert.equal(count,1);}finally{clearTimeout(keepAlive);}
  }
});
