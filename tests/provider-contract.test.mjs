import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {MihoyoTakumiClient,RECORDS} from "../packages/provider/mihoyo/src/client.mjs";
import {signDs} from "../packages/provider/mihoyo/src/signer.mjs";
const api=(data,retcode=0)=>new Response(JSON.stringify({retcode,data}));
test("DS generations match deterministic independent vectors and canonical query",()=>{
  const md5=text=>createHash("md5").update(text).digest("hex");
  assert.equal(signDs({salt:"fixture",generation:1,timestamp:1,nonce:"abcdef",body:"ignored",query:"ignored"}),"1,abcdef,"+md5("salt=fixture&t=1&r=abcdef"));
  assert.equal(signDs({salt:"fixture",generation:2,timestamp:1,nonce:"123456",body:'{"a":1}',query:"z=2&a=1"}),"1,123456,"+md5('salt=fixture&t=1&r=123456&b={"a":1}&q=a=1&z=2'));
  assert.throws(()=>signDs({salt:"x",generation:2,nonce:"abc"}));
});
test("all record families select correct host, identity keys and schedule query",async()=>{
  const calls=[];const client=new MihoyoTakumiClient({ck:"fixture"},{device_id:"device"},{fetchImpl:async(url,init)=>{calls.push({url:new URL(url),init});return api({});}});
  for(const [kind,[endpoint,identity,period]] of Object.entries(RECORDS)) {
    await client.record(kind,"17708598","prod_gf_cn",period?{schedule_type:2}:{});const call=calls.at(-1);
    assert.equal(call.url.pathname,"/event/game_record_zzz/api/zzz/"+endpoint);assert.equal(call.url.hostname,"api-takumi-record.mihoyo.com");
    assert.equal(call.url.searchParams.get(identity==="role"?"role_id":"uid"),"17708598");assert.equal(call.url.searchParams.get(identity==="role"?"server":"region"),"prod_gf_cn");
    if(period) assert.equal(call.url.searchParams.get("schedule_type"),"2");assert.equal(call.init.redirect,"error");assert.equal(call.init.headers.Cookie,"fixture");
  }
  await client.record("avatar","1000123456","prod_gf_us",{id_list:[1011,1021]});const call=calls.at(-1);
  assert.equal(call.url.hostname,"sg-act-public-api.hoyolab.com");assert.deepEqual(call.url.searchParams.getAll("id_list[]"),["1011","1021"]);
});
test("HTTP, schema, API errors and timeout are separate and do not disclose secrets",async()=>{
  for(const [fetchImpl,code] of [[async()=>new Response("bad",{status:503}),"HTTP"],[async()=>new Response("not-json"),"SCHEMA"],[async()=>api({},-100),"API"],[async()=>new Response('{}'),"SCHEMA"]]) {
    const client=new MihoyoTakumiClient("secret_cookie",{},{fetchImpl});await assert.rejects(client.record("note","1","prod_gf_cn"),err=>{assert.equal(err.code,code);assert.ok(!err.publicMessage.includes("secret_cookie"));return true;});
  }
  const client=new MihoyoTakumiClient("secret",{},{timeoutMs:5,fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}))});
  await assert.rejects(client.record("note","1","prod_gf_cn"),err=>err.code==="TIMEOUT");
});
test("absolute URLs are allowlisted, redirects forbidden and public gacha receives no cookies",async()=>{
  let calls=0,last;const client=new MihoyoTakumiClient("top_secret",{device_fp:"fp"},{fetchImpl:async(url,init)=>{calls++;last={url,init};return api({list:[]});}});
  for(const url of ["https://localhost/a","https://api-takumi.mihoyo.com.evil/a","https://api-takumi.mihoyo.com:444/a","http://api-takumi.mihoyo.com/a"]) await assert.rejects(client.request(url));
  assert.equal(calls,0);
  await client.gachaPage("1","prod_gf_cn","2001","900719925474099999","auth=key");assert.ok(!last.init.headers.Cookie);assert.ok(!last.init.headers.DS);assert.ok(!last.init.headers["x-rpc-device_fp"]);assert.equal(last.init.redirect,"error");assert.equal(new URL(last.url).searchParams.get("authkey"),"auth=key");
});
test("sign protocol uses info before action, correct act-id and explicit body",async()=>{
  let last;const client=new MihoyoTakumiClient("fixture",{},{fetchImpl:async(url,init)=>{last={url:new URL(url),init};return api({is_sign:false});}});
  await client.signInfo("1","prod_gf_cn");assert.equal(last.url.pathname,"/event/luna/zzz/info");assert.equal(last.url.searchParams.get("act_id"),"e202406242138391");assert.equal(last.init.headers["x-rpc-signgame"],"zzz");
  await client.sign("1","prod_gf_cn");assert.equal(last.init.method,"POST");assert.equal(JSON.parse(last.init.body).uid,"1");assert.equal(last.url.search,"");
});
test("Cookie gacha protocol translates named pools and actual gacha_item_list fields",async()=>{
  let query;const client=new MihoyoTakumiClient("cookie",{},{fetchImpl:async url=>{query=new URL(url).searchParams;return api({gacha_item_list:[{id:"900719925474099300",item_id:"1011",item_name:"安比",item_type:"ITEM_TYPE_AVATAR",rarity:"A",date:{year:2026,month:10,day:25,hour:8,minute:9,second:10}}]});}});
  const result=await client.gachaPage("17708598","prod_gf_cn","2001","0");
  assert.equal(query.get("gacha_type"),"GACHA_TYPE_CHARACTER_UP");assert.equal(result.list[0].gacha_type,"2001");assert.equal(result.list[0].rank_type,"3");assert.equal(result.list[0].uid,"17708598");assert.equal(result.list[0].time,"2026-10-25 08:09:10");assert.equal(result.list[0].id,"900719925474099300");
  await client.gachaPage("17708598","prod_gf_cn","13001","0");assert.equal(query.get("gacha_type"),"GACHA_TYPE_WEAPON_RETURN");
});
test("official live-code discovery fetches only fixed hosts and never sends credentials",async()=>{
  const calls=[];const client=new MihoyoTakumiClient("private",{},{fetchImpl:async(url,init)=>{
    calls.push(url);assert.ok(!init.headers.Cookie);assert.ok(!init.headers.DS);
    if(url.includes("/home/new"))return api({navigator:[{name:"前瞻直播",app_path:"https://act.mihoyo.com/?act_id=test_act&x=1"}]});
    if(url.includes("/index"))return api({live:{code_ver:"v1",title:"前瞻"}});
    return api({code_list:[{code:"FIXTURE_CODE",title:"<b>奖励</b>"}]});
  }});
  const result=await client.liveCodes();assert.equal(result.codes[0].code,"FIXTURE_CODE");assert.equal(calls.length,3);assert.ok(calls.at(-1).startsWith("https://api-takumi-static.mihoyo.com/"));
});
