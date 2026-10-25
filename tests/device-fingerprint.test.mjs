import test from "node:test";
import assert from "node:assert/strict";
import { issueDeviceFingerprint } from "../packages/provider/mihoyo/src/device.mjs";
const api=(data,retcode=0)=>new Response(JSON.stringify({retcode,data}));
test("device issuance uses the official public endpoint and validates both response codes",async()=>{
  let request;
  const device=await issueDeviceFingerprint({deviceId:"stable-device",now:()=>123,fetchImpl:async(url,init)=>{request={url,init};return api({code:200,device_fp:"123456789abcd"});}});
  assert.equal(request.url,"https://public-data-api.mihoyo.com/device-fp/api/getFp");
  assert.equal(request.init.redirect,"error");assert.equal(request.init.headers.Cookie,undefined);assert.equal(request.init.headers.DS,undefined);
  const body=JSON.parse(request.init.body);assert.match(body.device_fp,/^\d{10}$/);assert.equal(body.device_id,"stable-device");assert.equal(body.seed_time,"123");assert.equal(body.platform,"4");
  assert.equal(device.device_fp,"123456789abcd");assert.equal(device.device_fp_source,"official-web");assert.equal(device.device_fp_issued_at,123);
  await issueDeviceFingerprint({deviceId:"global",region:"prod_gf_us",fetchImpl:async(url,init)=>{assert.equal(new URL(url).hostname,"sg-public-data-api.hoyoverse.com");assert.equal(JSON.parse(init.body).app_name,"bbs_oversea");return api({code:200,device_fp:"123456789abcd"});}});
});
test("retcode zero with a rejected or malformed fallback fingerprint is never accepted",async()=>{
  for(const data of [{code:403,device_fp:"123456789abcd"},{code:200,device_fp:"1234567890"},{code:200,device_fp:["123456789abcd"]},{device_fp:"123456789abcd"}]) {
    await assert.rejects(issueDeviceFingerprint({deviceId:"test",fetchImpl:async()=>api(data)}),{code:"DEVICE_FP_REJECTED"});
  }
  await assert.rejects(issueDeviceFingerprint({deviceId:"test",fetchImpl:async()=>api({code:200,device_fp:"123456789abcd"},-1)}),{code:"DEVICE_FP_REJECTED"});
});
test("fingerprint network, HTTP and cancellation failures cannot create local random fallbacks",async()=>{
  for(const fetchImpl of [async()=>{throw new Error("network");},async()=>new Response("bad"),async()=>new Response("",{status:503})]) await assert.rejects(issueDeviceFingerprint({deviceId:"test",fetchImpl}));
  let requests=0;
  await assert.rejects(issueDeviceFingerprint({deviceId:"test",signal:AbortSignal.abort(),fetchImpl:async()=>{requests++;}}));
  assert.equal(requests,0);
});
