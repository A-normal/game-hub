import test from "node:test";
import assert from "node:assert/strict";
import {IdentityVault,GameHubDispatcher,logger,LogLevel} from "../packages/core/src/index.mjs";
import {MihoyoCommunityProvider} from "../packages/provider/mihoyo/src/index.mjs";
import {ZZZPluginManifest,encodeQRCode} from "../packages/plugin/zzz/src/index.mjs";
import {generateQrPngBase64} from "../packages/plugin/zzz/src/utils/qr-encoder.mjs";
test("logger levels and authentication QR formats remain available",async()=>{
  logger.setLevel("DEBUG"); assert.equal(logger.level,LogLevel.DEBUG); logger.setLevel("INFO");
  const qr=encodeQRCode("https://user.mihoyo.com/qr?ticket=fixture");
  assert.ok(qr.size>=21);assert.equal(qr.grid.length,qr.size);assert.match(qr.toAscii(),/[█▀▄]/);
  assert.equal(Buffer.from(qr.toBmpBase64(4).replace("base64://",""),"base64").toString("ascii",0,2),"BM");
  const png=Buffer.from((await generateQrPngBase64("https://user.mihoyo.com/qr?ticket=fixture")).replace("base64://",""),"base64");
  assert.equal(png[0],0x89);assert.equal(png.toString("ascii",1,4),"PNG");
});
test("system administration, plugin persistence and namespace conflicts",async t=>{
  const vault=new IdentityVault();t.after(()=>vault.close());const d=new GameHubDispatcher({vault,adminToken:"secret"});
  d.registerProvider(new MihoyoCommunityProvider());d.registerPlugin(ZZZPluginManifest);let reply="";
  const event=(text,user="guest")=>({unifiedUserId:"mock:"+user,platform:"mock",sender:{id:user},cleanText:text,reply:async value=>{reply=value;return {success:true};}});
  for (const text of ["#gh 帮助","#gh 状态","#gh 插件列表","#gh 禁用 zzz"]) {assert.equal((await d.dispatch(event(text))).status,"DENIED");assert.match(reply,/权限拒绝/);}
  await d.dispatch(event("#gh 认证 wrong"));assert.equal(d.isAdmin(event("")),false);
  await d.dispatch(event("#gh 认证 secret"));assert.equal(d.isAdmin(event("")),true);
  assert.deepEqual(vault.getSetting("system:admin_users"),["mock:guest"]);
  await d.dispatch(event("#gh 禁用 zzz"));assert.equal(d.isPluginEnabled("zzz"),false);
  await d.dispatch(event("#gh 启用 zzz"));assert.equal(d.isPluginEnabled("zzz"),true);
  await d.dispatch(event("#gh 命名空间 zzz # gh"));assert.match(reply,/被拒绝/);
  await d.dispatch(event("#gh 命名空间 zzz # zzz,绝区零"));assert.match(reply,/已更新/);
  await d.dispatch(event("#便签"));assert.match(reply,/绝区零便签/);assert.match(reply,/#扫码登录/);
  await d.dispatch(event("#gh 插件列表"));assert.match(reply,/绝区零 \(zzz\)/);assert.match(reply,/米游社 \(mihoyo\)/);
  const restored=new GameHubDispatcher({vault});restored.registerProvider(new MihoyoCommunityProvider());restored.registerPlugin(ZZZPluginManifest);
  assert.equal(restored.getNamespace("zzz").prefix,"#");assert.equal(restored.isAdmin(event("")),true);
});
test("pure-text help uses current namespace and excludes removed image routes",async t=>{
  const vault=new IdentityVault();t.after(()=>vault.close());const d=new GameHubDispatcher({vault});d.registerPlugin(ZZZPluginManifest);
  d.setNamespace("zzz",{prefix:"%",aliases:["绳匠"]});const pages=[];
  for (let page=1;page<=8;page++) await d.dispatch({cleanText:"%帮助 "+page,unifiedUserId:"mock:1",reply:async value=>pages.push(String(value))});
  const reply=pages.join("\n");
  assert.match(reply,/%更新抽卡/);assert.match(reply,/%更新面板/);assert.match(pages[0],/第 1 \/ \d+ 页/);
  for(const removed of ["换装","原图","简换装","#gh","*便签"]) assert.ok(!reply.includes(removed),removed);
  assert.equal(ZZZPluginManifest.routes.some(route=>route.tokens?.some(token=>/换装|原图/.test(token))),false);
});
