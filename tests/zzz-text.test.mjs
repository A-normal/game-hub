import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {IdentityVault,GameHubDispatcher} from "../packages/core/src/index.mjs";
import {ZZZPluginManifest} from "../packages/plugin/zzz/src/manifest.mjs";
import {ZzzStore} from "../packages/plugin/zzz/src/storage.mjs";
import {syncGacha,normalizeGacha,parseGachaLink,importGacha,gachaStatistics} from "../packages/plugin/zzz/src/gacha.mjs";
import {normalizeOfficialAvatar,normalizeEnkaAvatar,scoreAvatar,damageEstimate} from "../packages/plugin/zzz/src/panel.mjs";
import {ZzzTasks,chinaDay} from "../packages/plugin/zzz/src/tasks.mjs";
import {monthKey} from "../packages/plugin/zzz/src/handlers/records.mjs";
import {PUBLIC_ROLE,fetchPublicJson} from "../packages/plugin/zzz/src/public-data.mjs";
const owner="mock:1",role={uid:"17708598",region:"prod_gf_cn",nickname:"哲",level:60};
const avatar=(id,name,atk)=>({id,full_name:name,level:60,rank:1,properties:[{property_name:"攻击力",final:String(atk)},{property_name:"暴击率",final:"50%"},{property_name:"暴击伤害",final:"100%"}],equip:[],weapon:{name:"测试音擎",level:60}});
const record=(id,type="2",rank="2")=>({id,uid:role.uid,gacha_type:type,rank_type:rank,name:"真实记录名称",time:"2026-10-01 12:00:00"});
function setup(t,{client={},services={},config={}}={}) {
  const vault=new IdentityVault();t.after(()=>vault.close());vault.saveAccountBinding({unifiedUserId:owner,platform:"mock",originalId:"1",providerId:"mihoyo",accountKey:"100",gameId:"zzz",cookies:{ck:"fixture"},roles:[role]});
  const store=new ZzzStore(vault,services.now);const dispatcher=new GameHubDispatcher({vault});
  dispatcher.registerProvider({id:"mihoyo",capabilities:["game-record","account","sign","gacha"],createClient:()=>client});
  dispatcher.registerPlugin({...ZZZPluginManifest,config,services:{store,...services}});const replies=[];
  const event=(text,options={})=>({cleanText:text,unifiedUserId:owner,platform:"mock",sender:{id:"1",role:"member"},reply:async value=>{replies.push(String(value));return {success:true};},...options});
  return {vault,store,dispatcher,replies,event,run:(text,options)=>dispatcher.dispatch(event(text,options))};
}
test("automatic gacha command paginates all pools, commits atomically and repeats idempotently",async t=>{
  const calls=[];const client={gachaPage:async(uid,region,type,cursor)=>{calls.push([type,cursor]);return {list:type==="2001"?(cursor==="0"?[record("900719925474099301","2","4")]:cursor==="900719925474099301"?[record("900719925474099300")]:[]):[]};}};
  const h=setup(t,{client});assert.equal((await h.run("*更新抽卡")).status,"HANDLED");
  assert.equal(h.store.gacha(owner,role).length,2);assert.equal(h.store.gacha(owner,role)[0].id,"900719925474099300");assert.equal(calls.length,8);
  await h.run("*更新抽卡");assert.match(h.replies.at(-1),/新增 0 条/);
  await h.run("*抽卡分析");assert.match(h.replies.at(-1),/S 1；A 0/);assert.equal(gachaStatistics(h.store.gacha(owner,role))[1].s,1);
  assert.equal(h.store.gacha("other:1",role).length,0);
});
test("gacha rejects wrong account, cursor loops, unsafe links, numeric IDs and rolls back failed sync",async t=>{
  const h=setup(t);h.store.importGacha(owner,role,[normalizeGacha(record("10"),role)]);
  const client={gachaPage:async(uid,region,type,cursor)=>({list:type==="1001"&&cursor==="0"?[record("100","1")]:type==="2001"?[{...record("90"),uid:"999"}]:[]})};
  await assert.rejects(syncGacha({client,role,owner,store:h.store}),/UID/);assert.equal(h.store.gacha(owner,role).length,1);
  await assert.rejects(syncGacha({client:{gachaPage:async()=>({list:[record("11","1")]})},role,owner,store:h.store}),/游标/);
  assert.throws(()=>normalizeGacha({...record("1"),id:9007199254740992},role),/字符串/);
  assert.throws(()=>normalizeGacha({...record("1"),rank_type:"5"},role),/稀有度/);
  for(const url of ["http://127.0.0.1/a?authkey=x","https://public-operation-nap.mihoyo.com.evil.test/common/gacha_record/api/getGachaLog?authkey=x","https://public-operation-nap.mihoyo.com/evil?authkey=x"]) assert.throws(()=>parseGachaLink(url,role),/官方/);
  assert.equal(parseGachaLink("https://public-operation-nap.mihoyo.com/common/gacha_record/api/getGachaLog?authkey=abc%3D",role),"abc=");
  const payload=JSON.stringify({nap:[{uid:role.uid,list:[record("12")]}]});assert.equal(importGacha(payload,role)[0].id,"12");
  assert.throws(()=>importGacha(JSON.stringify({nap:[{uid:"other",list:[]}]}),role),/UID/);
});
test("official panel uses all owned characters; selected refresh preserves other cached characters",async t=>{
  let now=100000,calls=0,fail=false;let atk=2000;
  const client={record:async(type,uid,region,extra)=>{
    calls++;if(fail) throw Object.assign(new Error("fixture failure"),{publicMessage:"fixture failure"});
    if(type==="avatars") return {avatar_list:[avatar(1,"角色一",atk),avatar(2,"角色二",3000)]};
    assert.ok(extra.id_list.length);return {avatar_list:extra.id_list.map(id=>avatar(Number(id),Number(id)===1?"角色一":"角色二",Number(id)===1?atk:3000))};
  }};
  const h=setup(t,{client,services:{now:()=>now},config:{panelCooldownMs:1000}});
  await h.run("*更新面板");assert.equal(calls,2);assert.equal(h.store.get(owner,role,"panel","mihoyo").data.avatars.length,2);
  now+=2000;atk=2500;await h.run("*更新面板 角色一");let cache=h.store.get(owner,role,"panel","mihoyo");assert.equal(cache.data.avatars.length,2);assert.equal(cache.data.avatars.find(r=>r.id==="1").properties.攻击力.value,"2500");
  await h.run("*面板 角色一");assert.match(h.replies.at(-1),/攻击力: 2500/);assert.ok(!h.replies.at(-1).includes("3,180"));
  assert.equal((await h.run("*更新面板 角色一")).status,"FAILED");assert.match(h.replies.at(-1),/冷却/);
  now+=2000;fail=true;await h.run("*更新面板 角色一");assert.deepEqual(h.store.get(owner,role,"panel","mihoyo"),cache);
});
test("public UID only uses Enka showcase and never borrows another user's private credentials",async t=>{
  let requested;const h=setup(t,{client:{record:()=>assert.fail("must not call private API")},services:{fetchImpl:async url=>{requested=url;return {ok:true,json:async()=>({ttl:60,PlayerInfo:{ShowcaseDetail:{AvatarList:[{Id:1011,Name:"公开角色",Level:50,TalentLevel:2,EquippedList:[],Weapon:{Id:1,Level:40}}]}}})};}}});
  await h.run("*面板 12345678");assert.equal(requested,"https://enka.network/api/zzz/uid/12345678");assert.match(h.replies.at(-1),/公开角色/);
  await h.run("*面板 12345678 1011");assert.match(h.replies.at(-1),/未返回最终属性/);assert.match(h.replies.at(-1),/等级: 50/);
  assert.equal(normalizeEnkaAvatar({Id:1,Level:2,TalentLevel:0}).rank,0);
});
test("official battle families use correct periods and never fabricate missing scores or parties",async t=>{
  const calls=[];const h=setup(t,{client:{record:async(type,uid,region,extra)=>{calls.push([type,extra]);return type==="shiyu"?{hadal_info_v2:{total_star:9,list:[{floor:3,rating:"A"}]}}:{has_data:false};}}});
  await h.run("*式舆防卫战 上期");assert.deepEqual(calls[0],["shiyu",{schedule_type:2}]);assert.match(h.replies.at(-1),/星数: 9/);assert.ok(!h.replies.at(-1).includes("21"));assert.ok(!h.replies.at(-1).includes("艾莲"));
  for(const cmd of ["危局强袭战","全息拟境","模拟鏖战试炼","临界推演","零号空洞","枯萎之都","迷失之地","绝境作战","探索","活动日历"]) {await h.run("*"+cmd);assert.match(h.replies.at(-1),/暂无记录/);}
  assert.equal(calls.length,11);
});
test("monthly archive uses explicit year/month and aggregate never duplicates refreshed month",async t=>{
  const h=setup(t,{client:{monthly:async(uid,region,month)=>({data_month:month || "202601",month_data:{list:[{data_name:"菲林",count:100}]}})}});
  assert.equal(monthKey("202601"),"2026-01");assert.throws(()=>monthKey("2026-13"));
  await h.run("*月报 2026-01");await h.run("*月报 2026-01");await h.run("*月报汇总");assert.match(h.replies.at(-1),/菲林合计：100/);
  assert.equal(h.store.list(owner,role,"monthly").length,1);
});
test("scoring and damage only operate with explicit verified rules and real properties",()=>{
  const a=normalizeOfficialAvatar(avatar(1,"agent",2000));assert.equal(scoreAvatar(a),null);assert.equal(damageEstimate(a),null);
  assert.equal(scoreAvatar(a,{version:"fixture-v1",weights:{攻击力:1},reference:{攻击力:4000}}).score,50);
  const d=damageEstimate(a,{version:"fixture-v1",hits:[{name:"hit",stat:"攻击力",multiplier:2,canCrit:true}]},{resistance:0,defenseMultiplier:1});assert.equal(d.total,6000);
  assert.equal(damageEstimate({...a,properties:{}},{version:"fixture-v1",hits:[{stat:"攻击力",multiplier:2}]}),null);
});
test("persistent plugin caches and gacha records survive database close/reopen",()=>{
  const filename=path.resolve("tests/_tmp_zzz_text_"+process.pid+".db");let vault;
  try {vault=new IdentityVault(filename);let store=new ZzzStore(vault);store.importGacha(owner,role,[normalizeGacha(record("123456789012345678901"),role)]);store.put(owner,role,"panel","mihoyo",{avatars:[]});vault.close();vault=new IdentityVault(filename);store=new ZzzStore(vault);assert.equal(store.gacha(owner,role)[0].id,"123456789012345678901");assert.deepEqual(store.get(owner,role,"panel","mihoyo").data,{avatars:[]});}
  finally {vault?.close();if(fs.existsSync(filename))fs.unlinkSync(filename);}
});
test("explicit task opt-in, daily random slot, recovery dedupe, current namespace and lifecycle",async t=>{
  let now=Date.parse("2026-10-25T08:00:00+08:00"),signed=false,signs=0,deliveries=0,timerCreated=0,timerCleared=0;
  const h=setup(t,{client:{signInfo:async()=>({is_sign:signed}),sign:async()=>{signs++;signed=true;return {}; }},services:{now:()=>now}});
  const tasks=new ZzzTasks({store:h.store,vault:h.vault,dispatcher:h.dispatcher,now:()=>now,random:()=>9*60,setTimer:()=>{timerCreated++;return 1;},clearTimer:()=>timerCleared++});
  h.dispatcher.plugins.get("zzz").services.tasks=tasks;
  h.dispatcher.deliver=async(target,message)=>{deliveries++;assert.equal(target.userId,"1");assert.match(message,/%签到状态/);};
  assert.equal(h.store.jobs().length,0);await h.run("*自动签到 开启");const job=h.store.jobs(owner)[0];assert.equal(job.enabled,true);assert.equal(job.settings.minute,540);
  h.dispatcher.setNamespace("zzz",{prefix:"%",aliases:["new"]});now=job.nextRun+1000;
  await tasks.tick();assert.equal(signs,1);assert.equal(deliveries,1);assert.equal(h.store.runState(job.id,chinaDay(now)),"delivered");
  h.store.setJob({...h.store.jobs(owner)[0],nextRun:now-1});await tasks.tick();assert.equal(signs,1);assert.equal(deliveries,1);
  await tasks.start();assert.equal(timerCreated,1);await tasks.stop();assert.equal(timerCleared,1);
  await h.run("%自动签到 关闭");assert.equal(h.store.jobs(owner)[0].enabled,false);
});
test("group ranking requires group enablement, explicit publication and supports privacy and withdrawal",async t=>{
  const h=setup(t,{client:{record:async()=>({hadal_info_v2:{total_star:8,end_time:Math.floor(Date.now()/1000)+3600}})}});const group={isGroup:true,groupId:"g"};
  await h.run("*式舆防卫战");await h.run("*提交排名",group);assert.match(h.replies.at(-1),/尚未开启/);
  assert.equal((await h.run("*群排名设置 开启",group)).status,"DENIED");
  await h.run("*群排名设置 开启",{...group,sender:{id:"1",role:"admin"}});await h.run("*提交排名",group);await h.run("*群排名",group);assert.match(h.replies.at(-1),/哲/);
  await h.run("*排名隐私 隐藏");await h.run("*群排名",group);assert.ok(!h.replies.at(-1).includes("哲"));
  await h.run("*排名隐私 公开");await h.run("*撤回排名",group);await h.run("*群排名",group);assert.match(h.replies.at(-1),/暂无已授权/);
  await h.run("*群排名",{isGroup:true,groupId:"other"});assert.match(h.replies.at(-1),/尚未开启/);
});
test("public history supports version filters, reruns and persistent stale cache on source failure",async t=>{
  let fail=false;const h=setup(t,{services:{fetchImpl:async(url,init)=>{
    assert.ok(!init.headers.Cookie);if(fail)throw new Error("offline");
    return new Response(JSON.stringify([{title:"频段甲",version:"1.0",timer:"2024/07/04 ~ 2024/07/24",type:"角色",s:"角色甲",a:["角色乙"],img:"must-not-fetch"},{title:"频段乙",version:"1.2",timer:"2024/09/04 ~ 2024/09/24",type:"角色",s:"角色甲",a:[]} ]));
  }}});
  await h.run("*卡池历史 1.0");assert.match(h.replies.at(-1),/频段甲/);assert.ok(!h.replies.at(-1).includes("频段乙"));
  const cache=h.store.get("public",PUBLIC_ROLE,"public","poolHistory");assert.match(cache.data.hash,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(cache.data).includes("must-not-fetch"));
  await h.run("*复刻统计");assert.match(h.replies.at(-1),/角色甲：出现 2 次/);
  fail=true;await h.run("*更新卡池");assert.match(h.replies.at(-1),/刷新失败，展示原缓存/);assert.deepEqual(h.store.get("public",PUBLIC_ROLE,"public","poolHistory"),cache);
  await assert.rejects(fetchPublicJson("https://fixture/",{fetchImpl:async()=>new Response("x".repeat(30)),maxBytes:10}),/大小限制/);
});
test("content removes HTML, excludes expired codes and emits source links without image processing",async t=>{
  const h=setup(t,{config:{content:{guides:[{title:"攻略",source:"作者",url:"https://example.org/guide",text:"<script>bad()</script><b>文字建议</b>"}],codes:[{code:"OLD",source:"官方",url:"https://example.org/old",expiresAt:"2000-01-01"},{code:"NEW",source:"官方",url:"https://example.org/new",expiresAt:"2099-01-01"}]}}});
  await h.run("*攻略");assert.match(h.replies.at(-1),/文字建议/);assert.ok(!h.replies.at(-1).includes("bad()"));assert.ok(!h.replies.at(-1).includes("<b>"));
  await h.run("*兑换码");assert.match(h.replies.at(-1),/NEW/);assert.ok(!h.replies.at(-1).includes("OLD"));
});
