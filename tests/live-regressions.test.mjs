import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { unlinkSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IdentityVault, GameHubDispatcher, InboundShaper, Logger } from "../packages/core/src/index.mjs";
import { ZZZPluginManifest } from "../packages/plugin/zzz/src/manifest.mjs";
import { ZzzStore } from "../packages/plugin/zzz/src/storage.mjs";
import { getDs1, getDs2, SALTS } from "../packages/provider/mihoyo/src/signer.mjs";

const owner="mock:1", role={uid:"17708598",region:"prod_gf_cn",nickname:"绳匠",level:60};
function setup(t, client={}) {
  const vault=new IdentityVault();t.after(()=>vault.close());
  vault.saveAccountBinding({unifiedUserId:owner,platform:"mock",originalId:"1",providerId:"mihoyo",accountKey:"100",gameId:"zzz",cookies:{ck:"ltuid=100;cookie_token=test"},device:{device_id:"real-device",device_fp:"0123456789abc"},roles:[role]});
  const dispatcher=new GameHubDispatcher({vault,adminUsers:[owner]});
  const store=new ZzzStore(vault);const replies=[];
  dispatcher.registerProvider({id:"mihoyo",capabilities:["game-record","account","sign","gacha"],createClient:(cookies,device)=>{client.lastDevice=device;return client;}});
  dispatcher.registerPlugin({...ZZZPluginManifest,config:{},services:{store}});
  const run=(text,extra={})=>dispatcher.dispatch({cleanText:text,unifiedUserId:owner,platform:"mock",sender:{id:"1"},reply:async value=>{replies.push(String(value));return {success:true};},...extra});
  return {vault,store,dispatcher,replies,run};
}
test("group device mutations are refused before writes and device values remain private",async t=>{
  const h=setup(t),before=h.vault.getActiveRole(owner,"zzz").device;
  for(const cmd of ["删除设备","默认设备","重置设备","绑定设备 replacement 9999999999999"]) {
    assert.equal((await h.run("*"+cmd,{isGroup:true})).status,"DENIED");
    assert.deepEqual(h.vault.getActiveRole(owner,"zzz").device,before);
    assert.ok(!h.replies.at(-1).includes(before.device_fp));
  }
});
test("manual rebind sends and preserves the selected account's existing device",async t=>{
  const client={getUserGameRoles:async()=>[{game_uid:role.uid,region:role.region,nickname:role.nickname,level:60}]};
  const h=setup(t,client);
  await h.run("*绑定 ltuid=100;cookie_token=new-token");
  assert.deepEqual(client.lastDevice,{device_id:"real-device",device_fp:"0123456789abc"});
  assert.deepEqual(h.vault.getActiveRole(owner,"zzz").device,client.lastDevice);
});
test("tampered or wrong-key ciphertext fails closed before authenticated requests",async t=>{
  let calls=0;const h=setup(t,{getDailyNote:async()=>{calls++;}});
  h.vault._secretKey=Buffer.alloc(32,7);
  assert.throws(()=>h.vault.getActiveRole(owner,"zzz"),{code:"VAULT_DECRYPT"});
  h.vault._secretKey=null;
  h.vault.db.prepare("UPDATE community_credentials SET cookies_json=?").run("enc:v1:broken");
  assert.throws(()=>h.vault.getUserCredential(owner,"mihoyo","100"),{code:"VAULT_DECRYPT"});
  assert.equal((await h.run("*便签")).status,"FAILED");assert.equal(calls,0);
  assert.match(h.replies.at(-1),/解密失败/);
});
test("help, risk guidance and namespace clearing follow current configuration",async t=>{
  const h=setup(t,{getDailyNote:async()=>{throw Object.assign(new Error("API"),{retcode:10041,publicMessage:"设备校验（10041）"});}});
  h.dispatcher.setNamespace("zzz",{prefix:"&",aliases:["绳网"]});
  await h.run("&帮助");assert.ok(!h.replies.at(-1).includes("%便签"));assert.match(h.replies.at(-1),/&便签/);
  await h.run("&便签");assert.match(h.replies.at(-1),/&绑定设备 <设备JSON>/);assert.ok(!h.replies.at(-1).includes("扫码登录 重建设备"));assert.match(h.replies.at(-1),/正常重新扫码时保留/);
  await h.run('#命名空间 zzz & ""');assert.deepEqual(h.dispatcher.getNamespace("zzz").aliases,[]);
});
test("shared prefix hints reach their owner and disabled aliases never enter fallback",async()=>{
  const d=new GameHubDispatcher();let calls=[],fallback=0;
  for(const [id,priority] of [["high",100],["low",10]]) d.registerPlugin({id,name:id,defaultNamespace:{prefix:"!",aliases:[id],priority},routes:[{id:"help",tokens:["帮助"],action:()=>calls.push(id)}]});
  assert.equal(d.formatCommand({pluginId:"low",routeId:"help"}),"low帮助");
  await d.dispatch({cleanText:d.formatCommand({pluginId:"low",routeId:"help"})});assert.deepEqual(calls,["low"]);
  d.registerPlugin({id:"ai",routes:[{id:"fallback",stage:"fallback",action:()=>{fallback++;}}]});
  d.disablePlugin("low");
  await d.dispatch({cleanText:"LOW帮助",reply:async()=>{}});assert.equal(fallback,0);
  await d.dispatch({cleanText:"lowercase ordinary conversation"});assert.equal(fallback,1);
});
test("DS named exports use the named wire protocol including DS2 body and query",()=>{
  const md5=value=>createHash("md5").update(value).digest("hex");
  const [t1,r1,h1]=getDs1().split(",");assert.equal(h1,md5(`salt=${SALTS.community}&t=${t1}&r=${r1}`));
  const [t2,r2,h2]=getDs2("z=2&a=1",'{"x":1}').split(",");assert.equal(h2,md5(`salt=${SALTS.record}&t=${t2}&r=${r2}&b={"x":1}&q=a=1&z=2`));
});
test("rankings exclude legacy, expired and old periods and split regions",t=>{
  const h=setup(t);let now=1000;h.store.now=()=>now;
  const publish=(who,end,region=role.region)=>h.store.publish("g",who,{...role,region},"shiyu",8,{period:String(end),expiresAt:end});
  publish("old",2000);publish("current",3000);publish("global",4000,"prod_gf_us");
  assert.deepEqual(h.store.rankings("g","shiyu").map(row=>row.owner),["current","global"]);
  h.store.setOption("current","rankHidden",true);assert.deepEqual(h.store.rankings("g","shiyu").map(row=>row.owner),["global"]);
  now=4000;assert.deepEqual(h.store.rankings("g","shiyu"),[]);
  assert.throws(()=>publish("expired",3000));
});
test("rankings reject incomplete periods and permit withdrawal after group disablement",async t=>{
  const h=setup(t,{record:async()=>({total_star:8})}),group={isGroup:true,groupId:"g",sender:{id:"1",role:"admin"}};
  await h.run("*群排名设置 开启",group);await h.run("*深渊");
  assert.equal((await h.run("*提交排名",group)).status,"FAILED");assert.match(h.replies.at(-1),/周期/);
  await h.run("*群排名设置 关闭",group);await h.run("*撤回排名",group);assert.match(h.replies.at(-1),/已撤回/);
});
test("segment-only channel text is routed and structured/stack logs redact credentials",async t=>{
  assert.equal(InboundShaper.shape({post_type:"message",user_id:1,message:[{type:"text",data:{text:"*便签"}}]}).cleanText,"*便签");
  const lines=[];t.mock.method(console,"log",(...args)=>lines.push(args.join(" ")));t.mock.method(console,"error",(...args)=>lines.push(args.join(" ")));
  const logger=new Logger();
  logger.info("test",{stoken:"json-secret",ticket:"ticket-secret"},{ltoken:"extra-secret"});
  logger.error("test","failed",new Error("https://example.com/?authkey=link-secret&ticket=stack-secret"));
  logger.warn("test","&认证 admin-secret");
  for(const secret of ["json-secret","ticket-secret","extra-secret","link-secret","stack-secret","admin-secret"]) assert.ok(!lines.join("\n").includes(secret),secret);
});
test("read-only vault does not initialize or mutate a production-format database",()=>{
  const filename=fileURLToPath(new URL("./_tmp_live_"+randomUUID()+".db",import.meta.url));
  let writer,reader;
  try {
    writer=new IdentityVault(filename);writer.setSetting("sentinel",42);writer.close();writer=null;
    const before=statSync(filename).mtimeMs;
    reader=new IdentityVault(filename,{readOnly:true});assert.equal(reader.getSetting("sentinel"),42);
    assert.throws(()=>reader.setSetting("sentinel",0),/readonly|read-only/i);
    reader.close();reader=null;assert.equal(statSync(filename).mtimeMs,before);
  } finally {reader?.close();writer?.close();unlinkSync(filename);}
});
test("Enka access, rate and maintenance failures stay separate from community login",async t=>{
  const h=setup(t);
  for(const [status,message] of [[403,"上游拒绝"],[424,"可能正在维护"],[429,"过于频繁"]]) {
    h.dispatcher.plugins.get("zzz").services.fetchImpl=async()=>new Response("ignored",{status});
    assert.equal((await h.run("*面板 1000123456")).status,"FAILED");
    assert.ok(h.replies.at(-1).includes(message));assert.match(h.replies.at(-1),/旧缓存已保留/);
  }
});
