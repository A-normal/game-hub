import test from "node:test";
import assert from "node:assert/strict";
import {fileURLToPath} from "node:url";
import {IdentityVault,GameHubDispatcher,assembleModules} from "../packages/core/src/index.mjs";

const root=fileURLToPath(new URL("..",import.meta.url));
const descriptor=(kind,id,entry)=>({kind,id,entry});
const entry={provider:"packages/provider/mihoyo/src/index.mjs",plugin:"packages/plugin/zzz/src/index.mjs",channel:"packages/channel/napcat/src/index.mjs"};
const event=(text,options={})=>({cleanText:text,unifiedUserId:"test:1",platform:"test",sender:{id:"1"},reply:async()=>({success:true}),...options});
test("configuration assembly supports independent non-game modules and multiple providers",async t=>{
  const vault=new IdentityVault();t.after(()=>vault.close());const order=[];
  const modules=[descriptor("provider","one",entry.provider),descriptor("provider","two",entry.provider),descriptor("plugin","notes",entry.plugin),descriptor("channel","mock",entry.channel),{kind:"plugin",id:"disabled",enabled:false,entry:"does-not-exist"}];
  let n=0;
  const runtime=await assembleModules({root,vault,config:{version:1,modules},importModule:async url=>({createModule:async()=>{
    n++; const d=modules[n-1]; return {id:d.id,kind:d.kind,contractVersion:1,capabilities:["read"],providers:d.kind==="plugin"?[{id:"one",capabilities:["read"]},{id:"two",capabilities:["read"]}]:undefined,routes:[],start:async()=>order.push("start:"+d.id),stop:async()=>order.push("stop:"+d.id)};
  }})});
  assert.equal(n,4);assert.equal(runtime.dispatcher.plugins.get("notes").gameId,undefined);
  await runtime.start();await runtime.stop();assert.deepEqual(order,["start:one","start:two","start:notes","start:mock","stop:mock","stop:notes","stop:two","stop:one"]);
});
test("loader preflight rejects unsafe paths, duplicates, missing environment and capabilities",async t=>{
  const vault=new IdentityVault();t.after(()=>vault.close());let imported=0;
  const run=modules=>assembleModules({root,vault,config:{version:1,modules},env:{},importModule:async()=>{imported++;return {createModule:()=>({id:"p",kind:"plugin",contractVersion:1,routes:[],providers:[{id:"missing",capabilities:["read"]}]})};}});
  await assert.rejects(run([{...descriptor("plugin","p","app.mjs")}]),/packages/);assert.equal(imported,0);
  await assert.rejects(run([descriptor("plugin","p",entry.plugin),descriptor("plugin","p",entry.plugin)]),/重复/);assert.equal(imported,0);
  await assert.rejects(run([{...descriptor("plugin","p",entry.plugin),config:{secret:{$env:"NOT_SET",required:true}}}]),/NOT_SET/);assert.equal(imported,0);
  await assert.rejects(run([descriptor("plugin","p",entry.plugin)]),/missing provider/);
});
test("routing separates commands, business text and fallback without gaming assumptions",async()=>{
  const d=new GameHubDispatcher({adminToken:"secret"});let fallback=0,text=0;const replies=[];
  d.registerPlugin({id:"utility",name:"Utility",defaultNamespace:{prefix:"!",aliases:["util"]},routes:[
    {id:"ok",tokens:["run"],action:()=>{}}, {id:"bad",tokens:["bad"],action:()=>{throw new Error("private token");}},
    {id:"admin",tokens:["admin"],admin:true,action:()=>assert.fail()},
    {id:"business",stage:"text",match:e=>e.cleanText==="business",action:()=>{text++;}},
    {id:"fallback",stage:"fallback",action:()=>{fallback++;}}
  ]});
  const dispatch=text=>d.dispatch(event(text,{reply:async msg=>{replies.push(msg);return {success:true};}}));
  assert.equal((await dispatch("!run")).status,"HANDLED");
  assert.equal((await dispatch("!bad")).status,"FAILED");assert.ok(!replies.at(-1).includes("private token"));
  assert.equal((await dispatch("!admin")).status,"DENIED");
  assert.equal((await dispatch("!unknown")).status,"HANDLED");
  assert.equal((await dispatch("#unknown")).status,"HANDLED");assert.equal(fallback,0);
  await dispatch("business");assert.equal(text,1);assert.equal(fallback,0);
  await dispatch("ordinary words");assert.equal(fallback,1);
  d.disablePlugin("utility");await dispatch("!run");assert.equal(fallback,1);
});
test("command formatting reads namespace at use time, including delayed replies",async()=>{
  const d=new GameHubDispatcher();let release;const gate=new Promise(r=>release=r);let reply;
  d.registerPlugin({id:"plain",name:"Plain",defaultNamespace:{prefix:"!",aliases:["p"]},routes:[{id:"hello",tokens:["hello"],action:async ctx=>{await gate;await ctx.event.reply(ctx.commands.format({routeId:"hello",args:["next"]}));}}]});
  const pending=d.dispatch(event("!hello",{reply:async value=>reply=value}));
  d.setNamespace("plain",{prefix:"%",aliases:["updated"]});release();await pending;
  assert.equal(reply,"%updatedhello next");assert.equal(d.resolveNamespaceCandidates("!hello").length,0);
  assert.equal(d.resolveNamespaceCandidates("updatedsomething").length,0);
  assert.equal(d.resolveNamespaceCandidates("updated帮助")[0].gameId,"plain");
});
test("admin token grants only the authenticated platform identity and refuses group claims",async t=>{
  const vault=new IdentityVault();t.after(()=>vault.close());const d=new GameHubDispatcher({vault,adminToken:"s"});
  assert.equal((await d.dispatch(event("#gh 认证 s",{isGroup:true}))).status,"DENIED");
  assert.equal(d.isAdmin(event("")),false);await d.dispatch(event("#gh 认证 s"));
  assert.equal(d.isAdmin(event("")),true);assert.equal(d.isAdmin(event("",{unifiedUserId:"other:1"})),false);
  assert.deepEqual(vault.getSetting("system:admin_users"),["test:1"]);
});
test("shared account users select roles independently, including after database reopen semantics",async t=>{
  const v=new IdentityVault();t.after(()=>v.close());
  v.saveAccountBinding({unifiedUserId:"a:1",platform:"a",originalId:"1",providerId:"p",accountKey:"a",gameId:"g",cookies:{ck:"test"},roles:[{uid:"100",region:"r",nickname:"one"},{uid:"200",region:"r",nickname:"two"}]});
  v.bindUser("b:1","b","1","p","a");v.saveRoles("p","a","g",[{uid:"100",region:"r",nickname:"one"},{uid:"200",region:"r",nickname:"two"}]);
  v.setActiveRole("a:1","g","200");assert.equal(v.getActiveRole("a:1","g").uid,"200");assert.equal(v.getActiveRole("b:1","g").uid,"100");
  v._initTables();assert.equal(v.getActiveRole("a:1","g").uid,"200");assert.equal(v.getActiveRole("b:1","g").uid,"100");
  assert.equal(v.getUserCredential("evil:1","p","a"),null);
  v.unbindUser("a:1","p","a");assert.equal(v.getActiveRole("a:1","g"),null);assert.equal(v.getActiveRole("b:1","g").uid,"100");assert.equal(v.foreignKeyCheck().length,0);
});
test("configured shortcuts route directly to stable actions and enforce normal permissions",async()=>{
  const d=new GameHubDispatcher();const calls=[];
  d.registerPlugin({id:"utility",name:"utility",shortcuts:[{text:"/执行",routeId:"run"},{text:"／执行",routeId:"run"},{text:"执行",routeId:"run"}],routes:[{id:"run",tokens:["run"],action:ctx=>calls.push(ctx.args)}]});
  await d.dispatch(event("/执行 arg"));await d.dispatch(event("／执行"));await d.dispatch(event("执行"));assert.deepEqual(calls,[["arg"],[],[]]);
  assert.equal((await d.dispatch(event("执行一些普通话"))).status,"NOT_MATCHED");
  assert.throws(()=>d.registerPlugin({id:"other",name:"other",shortcuts:[{text:"/执行",routeId:"r"}],routes:[{id:"r",tokens:["r"],action:()=>{}}]}),/conflicting shortcut/);
});
