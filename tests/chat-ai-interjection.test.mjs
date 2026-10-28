import test from "node:test";
import assert from "node:assert/strict";
import {once} from "node:events";
import WebSocket from "ws";
import {IdentityVault,GameHubDispatcher,InboundShaper} from "../packages/core/src/index.mjs";
import {createModule} from "../packages/plugin/chat-ai/src/index.mjs";
import {parseCharacterCard} from "../packages/plugin/chat-ai/src/character.mjs";
import {buildPrompt} from "../packages/plugin/chat-ai/src/prompt.mjs";
import {interjectionSettings} from "../packages/plugin/chat-ai/src/interjection.mjs";
import {NapCatGateway} from "../packages/channel/napcat/src/server.mjs";

let seq=0;
const SID="mock:bot:group:g";
function setup(t,{complete=async()=>({text:"接一句"}),random=()=>0,config={}}={}) {
  const vault=new IdentityVault(":memory:"),d=new GameHubDispatcher({vault,adminUsers:["mock:admin","qq-napcat:123"]});
  const replies=[],calls=[];let time=100000,draws=0;
  d.registerProvider({id:"llm",capabilities:["chat"],createClient:()=>({complete:async input=>{calls.push(input);return complete(input);}})});
  const p=createModule({vault,dispatcher:d,now:()=>time,random:()=>{draws++;return random();},config:{model:{defaultProfileId:"main"},...config}});
  d.registerPlugin(p);const store=p.services.store;
  store.saveModel({id:"main",endpoint:"https://api.example.com/v1",model:"example",apiKeyEnv:"CHATAI_TEST_KEY"});
  const event=(text,extra={})=>({eventId:"i-"+(++seq),messageId:"msg-"+seq,platform:"mock",botId:"bot",isGroup:true,groupId:"g",unifiedUserId:"mock:admin",sender:{id:"admin",name:"测试者"},cleanText:text,reply:async content=>{replies.push(content);return {success:true,messageId:"out-"+(++seq)};},...extra});
  const send=async(text,extra={})=>{const out=await d.dispatch(event(text,extra));await p.services.engine.drain();return out;};
  const enable=async()=>{await send("!插话设置 on");replies.length=0;};
  t.after(async()=>{await p.stop();vault.close();});
  return {vault,d,p,store,calls,replies,event,send,enable,advance:ms=>time+=ms,draws:()=>draws,last:()=>store.getOption(SID,"interjectionLast",{}).reason};
}

test("自然插话默认关闭，开启后窗口只抽一次；沉默不发消息但调用计费",async t=>{
  const f=setup(t,{complete:async()=>({text:"[不回复]"}),random:()=>0.5});
  await f.send("旁听内容");assert.equal(f.calls.length,0);
  await f.enable();await f.send("第一句");await f.send("第二句");
  assert.equal(f.draws(),1);assert.equal(f.calls.length,0);assert.equal(f.last(),"window");
  f.advance(15000);await f.send("!插话设置 概率 100");f.replies.length=0;
  await f.send("第三句");assert.equal(f.calls.length,1);assert.equal(f.last(),"silence");assert.deepEqual(f.replies,[]);
  assert.equal(f.store.getUsage(SID).requests,1);
});

test("关键词概率与普通机会分开；不在每条消息上重抽，人物兴趣可选且不启用开关",async t=>{
  const f=setup(t,{random:()=>0.2,complete:async()=>({text:"[不回复]"})});await f.enable();
  await f.send("!插话设置 关键词 园艺");await f.send("普通话题");assert.equal(f.calls.length,0);
  await f.send("园艺");assert.equal(f.calls.length,0);
  f.advance(15000);await f.send("园艺怎么入门");assert.equal(f.calls.length,1);
  const parsed=parseCharacterCard({name:"公开测试角色",extensions:{game_hub:{interjection:{keywords:["天文"],probability:100,enabled:true}}}});
  f.store.saveCharacter({id:parsed.id,name:parsed.card.name,card:parsed.card,owner:"test-fixture"});
  await f.send("!人物切换 "+parsed.id);f.advance(15000);await f.send("天文观测");assert.equal(f.calls.length,2);
  await f.send("!插话设置 off");f.advance(15000);await f.send("天文观测");assert.equal(f.calls.length,2);
});

test("@和回复已交付的机器人消息跳过概率与冷却；其他人的引用和@不插话",async t=>{
  const f=setup(t,{random:()=>0.99});await f.enable();await f.send("!插话设置 概率 0");
  await f.send("叫你",{mentionedBot:true});assert.equal(f.calls.length,1);
  const replyId=f.store.recentMessages(SID).find(row=>row.role==="assistant").messageId;
  await f.send("继续",{replyMessage:{id:replyId}});assert.equal(f.calls.length,2);assert.equal(f.draws(),0);
  f.advance(60000);await f.send("问别人",{mentions:[{id:"other"}]});assert.equal(f.last(),"addressed_elsewhere");
  await f.send("回复别人",{replyMessage:{id:"someone-else"}});assert.equal(f.last(),"reply_elsewhere");assert.equal(f.calls.length,2);
});

test("发言冷却、每小时上限、每日调用额度分别执行",async t=>{
  const f=setup(t);await f.enable();await f.send("!插话设置 每小时 1");
  await f.send("第一句");assert.equal(f.last(),"sent");await f.send("第二句");assert.equal(f.last(),"cooldown");
  f.advance(60000);await f.send("第三句");assert.equal(f.last(),"hour_limit");assert.equal(f.calls.length,1);
  f.advance(3600000);await f.send("第四句");assert.equal(f.calls.length,2);
  const q=setup(t,{config:{limits:{requestsPerDay:1}},complete:async()=>({text:"[不回复]"})});await q.enable();
  await q.send("一次判断");q.advance(15000);await q.send("第二次");assert.equal(q.last(),"quota");assert.equal(q.calls.length,1);
});

test("新消息使进行中的插话过时，忙碌时不排队多个判断；模型错误不会打断群聊",async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const f=setup(t,{complete:async()=>{await gate;return {text:"迟到插话"};}});await f.enable();
  await f.d.dispatch(f.event("旧话题"));await f.d.dispatch(f.event("新话题"));assert.equal(f.calls.length,1);
  release();await f.p.services.engine.drain();assert.equal(f.last(),"stale");assert.deepEqual(f.replies,[]);
  assert.equal(f.store.recentMessages(SID).filter(r=>r.role==="assistant").length,0);
  const e=setup(t,{complete:async()=>{throw Object.assign(new Error("故障"),{code:"LLM_TIMEOUT"});}});await e.enable();
  await e.send("旁听");assert.equal(e.last(),"error");assert.deepEqual(e.replies,[]);
});

test("插话上下文含临时说话人与引用关系，原始账号和消息标识不发送给模型",async t=>{
  const f=setup(t,{complete:async()=>({text:"[不回复]"})});
  await f.send("最早发言",{messageId:"private-message-identifier",unifiedUserId:"mock:private-account-identifier",sender:{id:"private-account-identifier",name:"甲"}});
  await f.send("先前的引用",{replyMessage:{id:"private-message-identifier"},mentions:[{id:"private-account-identifier"}]});
  await f.enable();
  await f.send("后续发言");
  const prompt=JSON.stringify(f.calls[0]);assert.match(prompt,/群友1/);assert.match(prompt,/消息1/);
  assert.doesNotMatch(prompt,/private-account-identifier|private-message-identifier|mock:admin/);
  assert.match(prompt,/\[不回复\]/);
  assert.match(prompt,/replyTo\\":\\"消息1/);
});

test("发送确认期间出现新消息，已交付插话仍计入小时次数和发言冷却",async t=>{
  const f=setup(t);await f.enable();let release,entered;
  const ack=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  await f.d.dispatch(f.event("可以接话",{reply:async()=>{entered();await ack;return {success:true,messageId:"confirmed"};}}));
  await started;await f.d.dispatch(f.event("更新话题"));release();await f.p.services.engine.drain();
  assert.equal(f.store.getOption(SID,"interjectionTurns").length,1);
  assert.equal(typeof f.store.getOption(SID,"interjectionLastSpoke"),"number");
  assert.equal(f.last(),"sent_stale");
});

test("长人物设定不能裁掉旁听沉默规则，所有模型输入仍在上下文字符预算内",()=>{
  const prompt=buildPrompt({character:{name:"测试角色",description:"设定".repeat(10000)},history:[null,{role:"user",text:"话题".repeat(2000),senderId:"mock:someone",messageId:"raw-message"}],maxContextChars:2000,isGroup:true,interjection:true});
  assert.match(prompt.system,/只输出\[不回复\]/);
  assert.ok(Array.from(prompt.system+prompt.messages.map(m=>m.content).join("")).length<=2000);
});

test("续聊提高同一人的机会，不扩散到其他群友",async t=>{
  const f=setup(t,{random:()=>0.5});await f.enable();
  await f.send("先问你",{mentionedBot:true});f.advance(60000);
  await f.send("换个人",{unifiedUserId:"mock:other",sender:{id:"other",name:"另一人"}});assert.equal(f.calls.length,1);
  f.advance(15000);await f.send("接着说");assert.equal(f.calls.length,2);
});

test("只对目标群生效；off停止记录，all沿用逐条回复；敏感消息和未知命令不参与",async t=>{
  const f=setup(t);await f.enable();
  await f.send("其他群",{groupId:"other"});await f.send("!未知命令");await f.send("Cookie: secret");assert.equal(f.calls.length,0);
  await f.send("!策略设置 off");const before=f.store.countMessages(SID);await f.send("关闭后的话");assert.equal(f.store.countMessages(SID),before);
  await f.send("!策略设置 all");await f.send("每条回复");await f.send("仍然回复");assert.equal(f.calls.length,2);assert.equal(f.draws(),0);
});

test("插话设置有管理员权限、边界校验和动态命名空间；重建保留配置",async t=>{
  const f=setup(t);await f.enable();
  await f.send("!插话设置 off",{unifiedUserId:"mock:guest",sender:{id:"guest"}});assert.equal(f.store.getOption(SID,"interjection").enabled,true);
  for(const text of ["概率 -1","概率 101","窗口 0","冷却 0","每小时 0","关键词 Cookie: secret","__proto__ 10"])await f.send("!插话设置 "+text);
  assert.equal(interjectionSettings(f.store,SID).probability,5);
  assert.equal(Object.hasOwn(f.store.getLocalOption(SID,"interjection"),"probability"),false);
  f.d.setNamespace("chat-ai",{prefix:"~",aliases:[]});await f.send("~插话状态");assert.match(f.replies.at(-1),/~插话设置 on/);
  const replacement=createModule({vault:f.vault,dispatcher:f.d});assert.equal(replacement.services.store.getOption(SID,"interjection").enabled,true);await replacement.stop();
});

test("关闭插话或切换人物会取消旧结果，未调用模型的通知也初始化会话并报告原因",async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const f=setup(t,{complete:async()=>{await gate;return {text:"过时输出"};}});await f.enable();
  await f.d.dispatch(f.event("准备接话"));await f.d.dispatch(f.event("!插话设置 off"));release();await f.p.services.engine.drain();
  assert.ok(!f.replies.includes("过时输出"));assert.equal(f.store.getUsage(SID).requests,1);
  const e=setup(t);await e.d.dispatch(e.event("",{eventType:"notice",noticeType:"notify",noticeSubtype:"poke",targetUserId:"bot"}));
  assert.ok(e.store.getSession(SID));assert.equal(e.store.getOption(SID,"lastEventResult").reason,"disabled");
});

test("首个真实形状的戳一戳通知可走模板，无模型；目标、重复、冷却和交付失败可诊断",async t=>{
  const f=setup(t),id="qq-napcat:999:group:456";
  // Simulate persisted options before the first notice; no session row exists yet.
  f.store.setOption(id,"event:poke",{mode:"template"});
  const raw={post_type:"notice",notice_type:"notify",sub_type:"poke",self_id:999,user_id:123,target_id:999,group_id:456,time:200};
  const shaped=()=>InboundShaper.shape(raw,{sendFunction:async(_,text)=>{f.replies.push(text);return {success:true};}});
  await f.d.dispatch(shaped());assert.equal(f.replies.at(-1),"嗯？我在，想聊些什么？");assert.equal(f.calls.length,0);
  await f.d.dispatch(shaped());assert.equal(f.store.getOption(id,"lastEventResult").reason,"duplicate");
  raw.time++;await f.d.dispatch(shaped());assert.equal(f.store.getOption(id,"lastEventResult").reason,"cooldown");
  raw.target_id=124;await f.d.dispatch(shaped());assert.equal(f.store.getOption(id,"lastEventResult").reason,"target_other");
  raw.target_id=999;raw.time++;f.advance(30000);
  await f.d.dispatch(InboundShaper.shape(raw,{sendFunction:async()=>({success:false})}));assert.equal(f.store.getOption(id,"lastEventResult").reason,"delivery_failed");
});

test("前台反向WebSocket通知贯穿网关、分发、插件模板和RPC确认",async t=>{
  const f=setup(t),id="qq-napcat:999:group:456",requests=[];
  f.store.setOption(id,"event:poke",{mode:"template"});
  let finish,fail;const done=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
  const gateway=new NapCatGateway({host:"127.0.0.1",port:0,accessToken:"test-poke",dispatcher:{dispatch:async e=>{try{await f.d.dispatch(e);finish();}catch(error){fail(error);}}}});
  await gateway.start();
  const ws=new WebSocket(`ws://127.0.0.1:${gateway.server.address().port}/onebot/v11/ws`,{headers:{Authorization:"Bearer test-poke"}});
  t.after(async()=>{ws.terminate();await gateway.stop();});
  ws.on("message",raw=>{const request=JSON.parse(raw);requests.push(request);ws.send(JSON.stringify({echo:request.echo,status:"ok",retcode:0,data:{message_id:678}}));});
  await once(ws,"open");const timeout=setTimeout(()=>fail(Error("poke integration timed out")),2000);
  try{ws.send(JSON.stringify({post_type:"notice",notice_type:"notify",sub_type:"poke",self_id:999,user_id:123,target_id:999,group_id:456,time:201}));await done;}finally{clearTimeout(timeout);}
  assert.equal(requests.length,1);assert.equal(requests[0].action,"send_msg");assert.equal(String(requests[0].params.group_id),"456");
  assert.equal(f.store.getOption(id,"lastEventResult").reason,"template_sent");assert.equal(f.calls.length,0);
});
