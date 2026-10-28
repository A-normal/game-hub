import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {IdentityVault,GameHubDispatcher} from "../packages/core/src/index.mjs";
import {createModule} from "../packages/plugin/chat-ai/src/index.mjs";
import {interjectionSettings} from "../packages/plugin/chat-ai/src/interjection.mjs";
import {resolvePolicy} from "../packages/plugin/chat-ai/src/session.mjs";

let sequence=0;
const id=group=>"mock:bot:group:"+group;
function setup(t,{database=":memory:",complete=async()=>({text:"测试回答"}),config={}}={}) {
  const vault=new IdentityVault(database),d=new GameHubDispatcher({vault,adminUsers:["mock:admin"]});
  const calls=[],replies=[];let time=100000,closed=false;
  d.registerProvider({id:"llm",capabilities:["chat"],createClient:()=>({complete:async input=>{calls.push(input);return complete(input,calls.length);}})});
  const p=createModule({vault,dispatcher:d,config:{...config,model:{defaultProfileId:"test-model",...config.model}},now:()=>time,random:()=>0});
  d.registerPlugin(p);const store=p.services.store;
  if(!store.getModel("test-model"))store.saveModel({id:"test-model",endpoint:"https://api.example.com/v1",model:"test",apiKeyEnv:"CHATAI_TEST_KEY"});
  const event=(text,group="g1",extra={})=>({eventId:"prefs-"+(++sequence),messageId:"msg-"+sequence,platform:"mock",botId:"bot",isGroup:group!==null,groupId:group || undefined,unifiedUserId:"mock:admin",sender:{id:"admin",name:"测试管理员"},cleanText:text,reply:async content=>{replies.push({group,content});return {success:true,messageId:"sent-"+(++sequence)};},...extra});
  const send=async(text,group=null,extra={})=>{const start=replies.length;const out=await d.dispatch(event(text,group,extra));await p.services.engine.drain();return {out,text:replies.slice(start).map(r=>r.content).join("\n")};};
  const close=async()=>{if(!closed){await p.stop();vault.close();closed=true;}};
  t.after(close);
  return {vault,d,p,store,calls,replies,event,send,close,advance:ms=>time+=ms};
}
function card(f,name) {f.store.saveCharacter({id:name,name,card:{name,description:"独立构造的通用测试人物 "+name},owner:"test-fixture"});}

test("全局人物实时继承；本群独立人物、明确无人物与恢复继承保持不同语义",async t=>{
  const f=setup(t);card(f,"角色甲");card(f,"角色乙");
  await f.send("!设置 全局 人物 角色甲");await f.send("普通消息","g1");await f.send("!人物切换 角色乙","g2");
  assert.equal(f.store.getSession(id("g1")).characterId,"角色甲");assert.equal(f.store.getSession(id("g2")).characterId,"角色乙");
  await f.send("!人物卸下","g3");assert.equal(f.store.getSession(id("g3")).characterId,null);
  await f.send("!设置 全局 人物 角色乙");assert.equal(f.store.getSession(id("g1")).characterId,"角色乙");assert.equal(f.store.getSession(id("g3")).characterId,null);
  await f.send("!人物切换 跟随全局","g3");assert.equal(f.store.getSession(id("g3")).characterId,"角色乙");
  await f.send("!设置 本群 人物 无","g3");await f.send("!设置 全局 人物 角色甲");assert.equal(f.store.getSession(id("g3")).characterId,null);
  const view=await f.send("!设置","g1");assert.match(view.text,/人物：角色甲（跟随全局）/);
  const local=await f.send("!设置","g2");assert.match(local.text,/人物：角色乙（本会话指定）/);
});

test("插话只覆盖修改字段；全局变更不固化本群其他参数，可单字段恢复继承",async t=>{
  const f=setup(t);
  await f.send("!设置 全局 插话 on");await f.send("!设置 全局 插话 概率 20");
  await f.send("!插话设置 冷却 90","g1");
  assert.deepEqual(f.store.getLocalOption(id("g1"),"interjection"),{cooldownMs:90000});
  await f.send("!设置 全局 插话 概率 70");assert.equal(interjectionSettings(f.store,id("g1")).probability,70);
  await f.send("!插话设置 概率 10","g1");await f.send("!设置 全局 插话 概率 40");assert.equal(interjectionSettings(f.store,id("g1")).probability,10);
  await f.send("!插话设置 概率 跟随全局","g1");assert.equal(interjectionSettings(f.store,id("g1")).probability,40);assert.equal(interjectionSettings(f.store,id("g1")).cooldownMs,90000);
  await f.send("!插话设置 off","g1");await f.send("!设置 全局 插话 on");assert.equal(interjectionSettings(f.store,id("g1")).enabled,false);
  await f.send("!插话设置 跟随全局","g1");assert.equal(interjectionSettings(f.store,id("g1")).enabled,true);assert.equal(f.store.getLocalOption(id("g1"),"interjection"),undefined);
});

test("群聊与私聊默认策略分开；明确关闭、旧绑定、恢复继承都保留",async t=>{
  const f=setup(t);await f.send("!策略设置 off","g2");
  await f.send("!设置 全局 群聊策略 all");await f.send("群一消息","g1");await f.send("群二消息","g2");assert.equal(f.calls.length,1);
  await f.send("!设置 全局 私聊策略 off");await f.send("私聊消息",null);assert.equal(f.calls.length,1);
  assert.equal(resolvePolicy(f.store.getSession(id("g2")),f.p.config),"off");
  await f.send("!策略设置 跟随全局","g2");await f.send("现在回应","g2");assert.equal(f.calls.length,2);
  await f.send("!设置 本会话 策略 all",null);await f.send("单独恢复私聊",null);assert.equal(f.calls.length,3);
});

test("全局事件模板生效，本群off不会被开启覆盖；逐事件恢复不改变其他事件",async t=>{
  const f=setup(t),notice={eventType:"notice",noticeType:"notify",noticeSubtype:"poke",targetUserId:"bot"};
  await f.send("!设置 全局 事件 poke template 通用戳一戳");
  await f.send("", "g1",notice);assert.equal(f.replies.at(-1).content,"通用戳一戳");assert.equal(f.calls.length,0);
  await f.send("!事件设置 poke off","g2");await f.send("!设置 全局 事件 poke template 新模板");
  const silent=await f.send("","g2",notice);assert.equal(silent.text,"");
  await f.send("!事件设置 join off","g2");await f.send("!事件设置 poke 跟随全局","g2");f.advance(30000);
  await f.send("","g2",notice);assert.equal(f.replies.at(-1).content,"新模板");assert.equal(f.store.getOption(id("g2"),"event:join").mode,"off");
});

test("旧版事件总开关不会阻止某一类型恢复全局，其他旧事件值保留",async t=>{
  const f=setup(t);await f.send("普通消息","g1");
  f.store.setOption(id("g1"),"eventsEnabled",true);f.store.setOption(id("g1"),"event:poke",{mode:"template"});
  await f.send("!事件设置 poke 跟随全局","g1");
  const response=await f.send("","g1",{eventType:"notice",noticeType:"notify",noticeSubtype:"poke",targetUserId:"bot"});
  assert.equal(response.text,"");assert.equal(f.store.getOption(id("g1"),"event:join").mode,"template");
  assert.equal(f.store.getLocalOption(id("g1"),"eventsEnabled"),undefined);
});

test("窗口、单条长度、上下文预算和额度作用于实际记录及模型调用",async t=>{
  const f=setup(t);await f.send("!设置 全局 窗口 4");await f.send("!设置 全局 单条长度 50");await f.send("!设置 全局 上下文预算 2000");
  await f.send("!设置 本群 窗口 6","g2");
  for(let n=0;n<8;n++){await f.send("甲".repeat(100),"g1");await f.send("乙".repeat(100),"g2");}
  assert.equal(f.store.countMessages(id("g1")),4);assert.equal(f.store.countMessages(id("g2")),6);
  assert.ok(f.store.recentMessages(id("g1")).every(row=>row.text.length===50));
  await f.send("!设置 全局 每日额度 1");await f.send("!设置 本群 每日额度 2","g2");
  await f.send("问一","g1",{mentionedBot:true});await f.send("问二","g1",{mentionedBot:true});
  await f.send("问一","g2",{mentionedBot:true});await f.send("问二","g2",{mentionedBot:true});assert.equal(f.calls.length,3);
  for(const call of f.calls)assert.ok(Array.from(call.messages.map(m=>m.content).join("")).length<=2000);
});

test("更改全局人物取消跟随者旧生成，本群独立绑定的生成继续完成",async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const f=setup(t,{complete:async(input,n)=>{await gate;return {text:"完成"+n};}});card(f,"角色甲");card(f,"角色乙");
  await f.send("!设置 全局 人物 角色甲");await f.send("!人物切换 角色甲","g2");
  await f.d.dispatch(f.event("提问一","g1",{mentionedBot:true}));await f.d.dispatch(f.event("提问二","g2",{mentionedBot:true}));
  await f.d.dispatch(f.event("!设置 全局 人物 角色乙",null));
  assert.equal(f.calls[0].signal.aborted,true);assert.equal(f.calls[1].signal.aborted,false);
  release();await f.p.services.engine.drain();assert.ok(!f.replies.some(r=>r.content==="完成1"));assert.ok(f.replies.some(r=>r.content==="完成2"));
});

test("模型预算回退显示准确，设置全局预算即使等于启动默认也会取消受影响生成",async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const f=setup(t,{complete:async()=>{await gate;return {text:"旧预算结果"};}});
  f.store.saveModel({...f.store.getModel("test-model"),maxContextChars:4000});
  const view=await f.send("!设置","g1");assert.match(view.text,/上下文预算：4000字符/);
  await f.d.dispatch(f.event("旧预算提问","g1",{mentionedBot:true}));
  await f.d.dispatch(f.event("!设置 全局 上下文预算 12000",null));assert.equal(f.calls[0].signal.aborted,true);
  release();await f.p.services.engine.drain();assert.ok(!f.replies.some(r=>r.content==="旧预算结果"));
});

test("删除全局人物解除默认和会话绑定，其余人物与历史保持独立",async t=>{
  const f=setup(t);card(f,"角色甲");card(f,"角色乙");
  await f.send("!设置 全局 人物 角色甲");await f.send("甲历史","g1");
  await f.send("!人物切换 角色乙","g2");await f.send("乙历史","g2");
  await f.send("!人物删除 角色甲");assert.ok(f.store.getCharacter("角色甲"));
  await f.send("!人物删除 角色甲 确认");assert.equal(f.store.getSetting("default:characterId"),null);assert.equal(f.store.getSession(id("g1")).characterId,null);
  assert.equal(f.store.getSession(id("g2")).characterId,"角色乙");assert.ok(f.store.recentMessages(id("g2")).some(row=>row.text==="乙历史"));
});

test("切换全局人物保存原分支，群聊历史和显式记忆不因全局继承互通",async t=>{
  const f=setup(t);card(f,"角色甲");card(f,"角色乙");
  await f.send("!设置 全局 人物 角色甲");await f.send("只属于群一的内容","g1");await f.send("!记忆添加 群一登记的通用测试事实","g1");await f.send("!设置 全局 记忆 on");
  await f.send("群二提问","g2",{mentionedBot:true});assert.doesNotMatch(JSON.stringify(f.calls.at(-1)),/只属于群一|群一登记/);
  await f.send("群一提问","g1",{mentionedBot:true});assert.match(JSON.stringify(f.calls.at(-1)),/群一登记/);
  await f.send("!设置 全局 人物 角色乙");assert.equal(f.store.countMessages(id("g1")),0);
  await f.send("!设置 全局 人物 角色甲");assert.ok(f.store.recentMessages(id("g1")).some(row=>row.text==="只属于群一的内容"));
});

test("全局和会话配置在实际SQLite关闭重开后保留，不依赖原模块内存",async t=>{
  const root=mkdtempSync(join(tmpdir(),"gamehub-preferences-"));
  t.after(()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});});
  const database=join(root,"vault.sqlite"),f=setup(t,{database});card(f,"持久人物");
  await f.send("!设置 全局 人物 持久人物");await f.send("!设置 全局 群聊策略 all");await f.send("!设置 全局 事件 poke template 持久模板");await f.send("!设置 全局 插话 概率 32");await f.send("!设置 全局 窗口 60");
  await f.send("!设置 本群 窗口 8","g1");await f.send("!人物卸下","g2");await f.send("!插话设置 off","g1");await f.close();
  const again=setup(t,{database});
  assert.equal(again.store.getSession(id("g2")).characterId,null);assert.equal(again.store.runtimeConfig(id("g1"),again.p.config).retention.maxMessages,8);
  assert.equal(again.store.runtimeConfig(id("new"),again.p.config).retention.maxMessages,60);assert.equal(interjectionSettings(again.store,id("g1")).probability,32);
  await again.send("新群直接继承","new");assert.match(JSON.stringify(again.calls.at(-1)),/持久人物/);
  const response=await again.send("","g1",{eventType:"notice",noticeType:"notify",noticeSubtype:"poke",targetUserId:"bot"});assert.equal(response.text,"持久模板");
  await again.close();
});

test("人物列表明确标注名称ID编号，私聊选择仍绑定正确ID，群列表不覆盖私聊选择",async t=>{
  const f=setup(t);card(f,"角色甲");const list=await f.send("!人物列表");
  assert.match(list.text,/选择编号：1\n名称：角色甲\nID：角色甲/);assert.match(list.text,/不是人物ID/);
  card(f,"A新角色");const groupList=await f.send("!人物列表","g1");assert.match(groupList.text,/列表序号/);assert.match(groupList.text,/群内请使用人物ID/);
  await f.send("1");assert.equal(f.store.getSession("mock:bot:private:mock:admin").characterId,"角色甲");
});

test("统一设置保留管理员鉴权、参数校验与动态命名空间，查看不固化覆盖",async t=>{
  const f=setup(t);await f.send("!设置 全局 插话 概率 20");
  const denied=await f.send("!设置 全局 插话 概率 99","g1",{unifiedUserId:"mock:guest",sender:{id:"guest"}});assert.equal(denied.out.status,"DENIED");
  for(const args of ["全局 窗口 0","全局 私聊策略 mention","全局 插话 __proto__ 1","全局 事件 __proto__ on","全局 人物 不存在","全局 窗口 跟随全局"])await f.send("!设置 "+args);
  assert.equal(interjectionSettings(f.store,id("g1")).probability,20);
  f.d.setNamespace("chat-ai",{prefix:"~",aliases:[]});const view=await f.send("~设置","g1");
  assert.match(view.text,/~设置 本会话/);assert.doesNotMatch(view.text,/!设置/);assert.equal(f.store.getLocalOption(id("g1"),"interjection"),undefined);
  const help=await f.send("~帮助 设置");assert.match(help.text,/全局|本群/);
});
