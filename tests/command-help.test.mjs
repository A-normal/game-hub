import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {GameHubDispatcher, IdentityVault} from "../packages/core/src/index.mjs";
import zzz from "../packages/plugin/zzz/src/manifest.mjs";
import chat from "../packages/plugin/chat-ai/src/manifest.mjs";

const owner = "mock:admin";
function fixture() {
  const d = new GameHubDispatcher({adminUsers:[owner]});
  d.registerPlugin({...zzz,routes:zzz.routes.map(r=>({...r}))}); d.registerPlugin({...chat,routes:chat.routes.map(r=>({...r}))});
  const replies = [];
  const run = (text, extra={}) => d.dispatch({cleanText:text,unifiedUserId:owner,platform:"mock",botId:"999",sender:{id:"admin"},reply:async value=>{replies.push(String(value));},...extra});
  return {d,replies,run};
}

test("every public command has one name and complete help; querying all help never executes business handlers",async()=>{
  const {d,replies,run}=fixture(); let actions=0;
  for (const plugin of d.plugins.values()) {
    const rows=plugin.routes.filter(r=>(!r.stage || r.stage==="command") && r.tokens?.length);
    const tokens=new Set();
    for(const row of rows) {
      assert.equal(row.tokens.length,1,row.id);assert.ok(!tokens.has(row.tokens[0]));tokens.add(row.tokens[0]);
      assert.ok(row.description && row.help?.scope && Array.isArray(row.help.args),row.id);
      if(row.id!=="help") row.action=()=>{actions++;};
    }
    for(const row of rows) {
      const query=d.formatCommand({pluginId:plugin.id,routeId:"help",args:[row.tokens[0]]});
      await run(query);const text=replies.at(-1);
      assert.ok(text.includes(row.description),query);assert.match(text,/作用范围：/);assert.match(text,/用法：/);assert.match(text,/示例：/);
    }
    const all=[];
    for(let page=1;page<=Math.ceil(rows.length/14);page++) {
      await run(d.formatCommand({pluginId:plugin.id,routeId:"help",args:["全部",String(page)]}));all.push(replies.at(-1));
    }
    for(const row of rows)assert.ok(all.some(text=>text.includes(d.formatCommand({pluginId:plugin.id,routeId:row.id})+" ")),row.id);
  }
  assert.equal(actions,0);
});

test("removed synonyms and inverted panel syntax cannot fall through into another business command or AI",async()=>{
  const {d,replies,run}=fixture();let actions=0;
  for(const p of d.plugins.values())for(const r of p.routes)r.action=()=>{actions++;};
  const removed={
    zzz:["help","菜单","扫码绑定","扫码","二维码登录","二维码绑定","二维码","扫码终止","添加账号","选角色","设置角色","我的角色","角色清单","设备配置","重置设备","角色别名","刷新冷却","清除缓存","刷新资源","体力","电量","资料","名片","角色图鉴","邦布列表","刷新面板","刷新展柜","更新展柜","展柜列表","练度统计","深渊","防卫战","剧变节点","危局","拟境","鏖战试炼","爬塔","临界","临界总览","空洞","零号空洞二期","日历","收入","菲林","月报统计","卡池","版本卡池","刷新卡池","更新调频","刷新抽卡","记录链接","调频记录","每日签到","打卡","体力提醒","提醒状态","排名","影画","图鉴","角色一面板"],
    "chat-ai":["菜单","说","连接模型新增"],
    system:["help","菜单","","auth","绑定管理","登录管理","status","plugins","enable","disable","namespace","admins"]
  };
  for(const [id,tokens] of Object.entries(removed))for(const token of tokens) {
    await run(d.commandPrefix(id)+token);assert.match(replies.at(-1),/未识别该命令/,id+":"+token);
  }
  assert.equal(actions,0);
});

test("common help is short; details and page links use live markers, including aliases and shared prefixes",async()=>{
  const {d,replies,run}=fixture();
  for(const id of ["zzz","chat-ai","system"]) {
    d.setNamespace(id,{prefix:"&",aliases:[id+"入口"]});
    const help=d.formatCommand({pluginId:id,routeId:"help"});await run(help);
    assert.match(replies.at(-1),/常用指令/);assert.ok(replies.at(-1).split("\n").filter(x=>x.includes(" — ")).length<=12);
    await run(d.formatCommand({pluginId:id,routeId:"help",args:["全部","2"]}));
    assert.match(replies.at(-1),/第 \d+ \/ \d+ 页/);assert.ok(!replies.at(-1).includes("*帮助"));
  }
  d.setNamespace("zzz",{prefix:"",aliases:["绳网"]});
  await run("绳网帮助 绳网绑定设备");assert.match(replies.at(-1),/绳网绑定设备 <设备JSON>/);
  await run("绳网帮助 绑定");assert.match(replies.at(-1),/Cookie/);assert.match(replies.at(-1),/正常重新扫码保留/);
  await run("绳网帮助 不存在");assert.match(replies.at(-1),/未找到该指令的帮助/);
  await run("绳网帮助 全部 -1");assert.match(replies.at(-1),/页码应为正整数/);
});

test("help retains administrator access checks and never mutates accounts even in groups",async t=>{
  const vault=new IdentityVault();t.after(()=>vault.close());
  const d=new GameHubDispatcher({vault,adminUsers:[owner]});d.registerPlugin(zzz);d.registerPlugin(chat);
  let reply;const run=(text,user=owner)=>d.dispatch({cleanText:text,unifiedUserId:user,isGroup:true,groupId:"g",reply:async value=>{reply=String(value);}});
  const before=vault.db.prepare("SELECT count(*) AS n FROM community_credentials").get().n;
  await run("*帮助 删除设备");assert.match(reply,/保留账号认证/);
  await run("*帮助 绑定设备");assert.match(reply,/写入仅私聊/);
  assert.equal(vault.db.prepare("SELECT count(*) AS n FROM community_credentials").get().n,before);
  assert.equal((await run("!帮助","guest")).status,"DENIED");
  assert.equal((await run("#帮助 认证","guest")).status,"DENIED");
});

test("distinct ZZZ operations have separate routes and default configuration has no duplicate shortcuts",()=>{
  const d=new GameHubDispatcher();d.registerPlugin(zzz);
  for(const [token,id] of [["绑定","bind"],["绑定国际服","bindGlobal"],["绑定设备","device"],["删除设备","deviceClear"],["默认设备","deviceDefault"],["更新设备指纹","deviceFingerprint"],["设置别名","aliases"],["删除别名","aliasRemove"],["当前卡池","pools"],["卡池历史","poolHistory"],["复刻统计","poolReruns"]]) {
    assert.equal(d._matchCommand(d.plugins.get("zzz"),token)?.route.id,id);
  }
  const config=JSON.parse(fs.readFileSync(new URL("../config/modules.json",import.meta.url),"utf8"));
  assert.equal(config.modules.filter(m=>m.kind==="plugin").flatMap(m=>m.shortcuts || []).length,0);
});
