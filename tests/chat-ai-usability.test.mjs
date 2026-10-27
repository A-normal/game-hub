import test, {after} from "node:test";
import assert from "node:assert/strict";
import {IdentityVault,GameHubDispatcher,InboundShaper} from "../packages/core/src/index.mjs";
import {createModule} from "../packages/plugin/chat-ai/src/index.mjs";
import {ChatStore} from "../packages/plugin/chat-ai/src/store.mjs";
import {buildPrompt} from "../packages/plugin/chat-ai/src/prompt.mjs";
import {createLogger} from "../packages/plugin/chat-ai/src/log.mjs";
import {sessionKeyOf,dayKey} from "../packages/plugin/chat-ai/src/session.mjs";
import {once} from "node:events";
import WebSocket from "ws";
import {checkSingleProfile} from "../packages/plugin/chat-ai/src/health.mjs";
import {NapCatGateway,encodeMessage} from "../packages/channel/napcat/src/server.mjs";

const previous=process.env.CHATAI_KEY_DIAG;process.env.CHATAI_KEY_DIAG="diagnostic-only-placeholder";
after(()=>{if(previous===undefined)delete process.env.CHATAI_KEY_DIAG;else process.env.CHATAI_KEY_DIAG=previous;});
let sequence=0;
function fixture(t,{withModel=true,config={},complete=null}={}) {
  const vault=new IdentityVault(':memory:'),d=new GameHubDispatcher({vault,adminUsers:['mock:admin']});
  let time=Date.parse('2026-10-27T04:00:00Z');
  const calls=[],options=[],replies=[],deliveries=[],fetches=[];
  d.registerProvider({id:'llm',capabilities:['chat'],createClient:opts=>{options.push(opts);return {complete:async input=>{calls.push(input);return complete?complete(input,calls.length):{text:'正常回答',usage:{input:2,output:3}};}};}});
  d.deliver=async(target,content)=>{deliveries.push({target,content});return {success:true};};
  const p=createModule({vault,dispatcher:d,now:()=>time,config:withModel?{...config,model:{...config.model,defaultProfileId:'main'}}:config,fetchImpl:async(url,init)=>{fetches.push({url,init});return {ok:true,status:200,json:async()=>({data:[{id:'model-a'},{id:'model-b'}]})};}});
  d.registerPlugin(p);const store=p.services.store;
  if(withModel)store.saveModel({id:'main',label:'日常聊天',endpoint:'https://api.example.com/v1',model:'model-a',apiKeyEnv:'CHATAI_KEY_DIAG'});
  const event=(text,extra={})=>({eventId:'u-'+(++sequence),messageId:String(sequence),platform:'mock',botId:'999',unifiedUserId:'mock:admin',sender:{id:'admin',name:'测试者'},cleanText:text,reply:async content=>{replies.push(content);return {success:true};},...extra});
  const dispatch=async(text,extra={})=>{const start=replies.length;const out=await d.dispatch(event(text,extra));await p.services.engine.drain();return {out,replies:replies.slice(start),text:replies.slice(start).filter(x=>typeof x==='string').join('\n')};};
  t.after(async()=>{await p.stop();vault.close();});
  return {vault,d,p,store,calls,options,replies,deliveries,fetches,event,dispatch,advance:ms=>time+=ms,now:()=>time};
}

test('空库启动→服务向导→发现模型编号→保存并使用→聊天，无需重启',async t=>{
  const f=fixture(t,{withModel:false});await f.p.start();
  for(const text of ['!连接新增','主服务','https://api.example.com/v1','CHATAI_KEY_DIAG','确认'])await f.dispatch(text);
  assert.equal(f.store.listConnections().length,1);
  const discovered=await f.dispatch('!发现模型');assert.match(discovered.text,/1\. model-a/);
  await f.dispatch('1');await f.dispatch('日常聊天');await f.dispatch('确认并使用');
  await f.dispatch('你好');assert.equal(f.calls.length,1);
  const session=f.store.getSession('mock:999:private:mock:admin');assert.ok(session.modelProfileId);
  assert.equal(f.store.countMessages(session.sessionId),2);
  assert.equal(f.store.listModels()[0].label,'日常聊天');
  assert.equal(f.p.services.health.defaultProfileId,''); // 管理员显式选择，不重算其它会话默认模型。
  assert.equal(f.fetches.length,1);
});

test('旧模型表无损迁移、同连接复用、不同密钥隔离、重复迁移幂等',t=>{
  const vault=new IdentityVault(':memory:');t.after(()=>vault.close());
  vault.db.exec('CREATE TABLE chat_models(id TEXT PRIMARY KEY,label TEXT,endpoint TEXT NOT NULL,model TEXT NOT NULL,api_key_env TEXT NOT NULL,temperature REAL,max_output_tokens INTEGER,timeout_ms INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)');
  const stmt=vault.db.prepare('INSERT INTO chat_models VALUES(?,?,?,?,?,?,?,?,?,?)');
  stmt.run('legacy','旧档案','https://api.example.com/v1','model-a','CHATAI_KEY_DIAG',null,null,null,1,1);
  stmt.run('legacy2','另一个模型','https://api.example.com/v1','model-b','CHATAI_KEY_DIAG',null,null,null,2,2);
  const store=new ChatStore(vault);new ChatStore(vault);
  assert.equal(store.getModel('legacy').label,'旧档案');assert.equal(store.listConnections().length,1);
  store.saveModel({id:'other-key',endpoint:'https://api.example.com/v1',model:'model-a',apiKeyEnv:'CHATAI_KEY_OTHER'});
  assert.equal(store.listConnections().length,2);assert.notEqual(store.getModel('legacy').connectionId,store.getModel('other-key').connectionId);
  const connection=store.getConnection(store.getModel('legacy').connectionId);
  store.saveConnection({...connection,endpoint:'https://gateway.example.com/v2'});
  assert.equal(store.getModel('legacy').endpoint,'https://gateway.example.com/v2');assert.equal(store.getModel('legacy2').endpoint,'https://gateway.example.com/v2');
  assert.throws(()=>store.deleteConnection(connection.id),/Connection in use/);
});

test('显示名称、列表编号、详情、默认模型和会话选择持久化生效',async t=>{
  const f=fixture(t);f.store.saveModel({id:'reason',label:'复杂推理',connectionId:f.store.getModel('main').connectionId,model:'model-b'});
  const list=await f.dispatch('!模型列表');assert.match(list.text,/日常聊天/);assert.match(list.text,/复杂推理/);
  await f.dispatch('2');await f.dispatch('问题');assert.equal(f.options.at(-1).model,'model-b');
  const info=await f.dispatch('!模型详情');assert.match(info.text,/实际路径/);assert.match(info.text,/复杂推理/);assert.ok(!info.text.includes(process.env.CHATAI_KEY_DIAG));
  await f.dispatch('!默认模型 日常聊天');await f.dispatch('!模型切换 跟随默认');await f.dispatch('再问');assert.equal(f.options.at(-1).model,'model-a');
  await f.dispatch('!模型参数 main 输出 512');assert.equal(f.store.getModel('main').maxOutputTokens,512);
});

test('真实OneBot raw_message中的@和引用不会吞掉当前提问，@命令仍隔离',async t=>{
  const f=fixture(t);const raw={post_type:'message',message_type:'group',self_id:999,user_id:123,group_id:456,message_id:55,time:1793073600,
    raw_message:'[CQ:reply,id=11][CQ:at,qq=999] 当前提问',message:[{type:'reply',data:{id:11}},{type:'at',data:{qq:999}},{type:'text',data:{text:' 当前提问'}}]};
  const e=InboundShaper.shape(raw,{sendFunction:async(_t,msg)=>{f.replies.push(msg);return {success:true};}});
  assert.equal(e.cleanText,'当前提问');await f.d.dispatch(e);await f.p.services.engine.drain();
  assert.equal(f.calls.length,1);assert.ok(f.calls[0].messages.some(m=>m.content.includes('当前提问')));
  const command=InboundShaper.shape({...raw,message_id:56,raw_message:'[CQ:at,qq=999] !状态',message:[{type:'at',data:{qq:999}},{type:'text',data:{text:'!状态'}}]});
  await f.d.dispatch(command);assert.equal(f.calls.length,1);
});

test('事件去重覆盖模型调用，裁剪/清空/人物切换后也不重放',async t=>{
  const f=fixture(t,{config:{retention:{maxMessages:4}}}),e=f.event('同一问题');
  await f.d.dispatch(e);await f.p.services.engine.drain();await f.d.dispatch(e);await f.p.services.engine.drain();assert.equal(f.calls.length,1);
  for(let i=0;i<6;i++)await f.dispatch('新问题'+i);
  const before=f.calls.length;await f.dispatch('!清空上下文');await f.d.dispatch(e);await f.p.services.engine.drain();assert.equal(f.calls.length,before);
});

test('FIFO每个问题保留自己的上下文边界并接入先前回复',async t=>{
  let release;
  const f=fixture(t,{complete:async(input,n)=>{if(n===1)await new Promise((resolve,reject)=>{release=resolve;input.signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true});});return {text:'答'+n,usage:{input:1,output:1}};}});
  for(const text of ['问题1','问题2','问题3'])await f.d.dispatch(f.event(text));
  release();await f.p.services.engine.drain();assert.equal(f.calls.length,3);
  for(let i=0;i<3;i++){assert.equal(f.calls[i].messages.at(-1).content,'问题'+(i+1));for(let n=i+2;n<=3;n++)assert.ok(!f.calls[i].messages.some(m=>m.content==='问题'+n));}
  assert.ok(f.calls[1].messages.some(m=>m.content==='答1'));
});

test('每日限额在调用前预留，交付失败仍计入生成消耗',async t=>{
  let release;
  const f=fixture(t,{config:{limits:{requestsPerDay:1}},complete:async(input)=>{await new Promise((resolve,reject)=>{release=resolve;input.signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true});});return {text:'生成成功',usage:{input:4,output:5}};}});
  for(const text of ['一','二','三'])await f.d.dispatch(f.event(text,{reply:async()=>({success:false})}));
  release();await f.p.services.engine.drain();assert.equal(f.calls.length,1);
  const used=f.store.getUsage('mock:999:private:mock:admin',dayKey(f.now()));assert.equal(used.requests,1);assert.equal(used.tokensOut,5);
});

test('清空/停用后的旧失败不回复；显式指令不受自动提示冷却影响',async t=>{
  let reject;
  const f=fixture(t,{complete:async()=>new Promise((_r,j)=>reject=j)});
  await f.d.dispatch(f.event('原问题'));await f.d.dispatch(f.event('!清空上下文'));reject(Object.assign(new Error('timeout'),{code:'LLM_TIMEOUT'}));await f.p.services.engine.drain();
  assert.ok(!f.replies.some(r=>String(r).includes('暂时不可用')));
  await f.dispatch('!模型删除 main');const before=f.replies.length;await f.dispatch('!对话 一');await f.dispatch('!对话 二');assert.equal(f.replies.length-before,2);
});

test('默认警告可见，详细诊断可关闭，密钥脱敏',()=>{
  const old=console.warn,lines=[];console.warn=x=>lines.push(x);
  try{const log=createLogger({});log.debug('details');log.warn('necessary');log.error('Bearer secret-value sk-abcdefghijk');assert.equal(lines.length,2);assert.ok(!lines.join('').includes('secret-value'));assert.ok(!lines.join('').includes('sk-abcdefghijk'));}finally{console.warn=old;}
});

test('用户导入人物的同名保护、人物分支、开场白、编辑导出删除',async t=>{
  const f=fixture(t);assert.equal(f.store.listCharacters().length,0);
  await f.dispatch('!人物导入 '+JSON.stringify({name:'测试人物',description:'仅供自动化测试使用的虚构助手。',first_mes:'你好，这是测试问候。'}));assert.ok(f.store.getCharacter('测试人物'));
  await f.dispatch('旧人物的问题');await f.dispatch('!人物切换 测试人物');
  assert.equal(f.store.recentMessages('mock:999:private:mock:admin',20).filter(m=>m.role==='user').length,0);
  assert.ok(f.replies.some(r=>String(r).includes('测试问候')));
  const imported=await f.dispatch('!人物导入 {"name":"测试人物","description":"不能覆盖"}');assert.match(imported.text,/未覆盖/);
  await f.dispatch('!人物编辑 测试人物');await f.dispatch('personality');await f.dispatch('认真而俏皮');await f.dispatch('确认');
  const exported=await f.dispatch('!人物导出 测试人物');const parsed=JSON.parse(exported.replies.find(x=>x.files)?.files[0].data.toString('utf8'));assert.equal(parsed.data.personality,'认真而俏皮');
  const denied=await f.dispatch('!人物导出 测试人物',{isGroup:true,groupId:'g'});assert.match(denied.text,/私聊/);
  await f.dispatch('!人物卸下');assert.ok(f.store.recentMessages('mock:999:private:mock:admin',20).some(m=>m.text==='旧人物的问题'));
  await f.dispatch('!人物删除 测试人物');assert.ok(f.store.getCharacter('测试人物'));await f.dispatch('!人物删除 测试人物 确认');assert.equal(f.store.getCharacter('测试人物'),null);
  createModule({vault:f.vault,dispatcher:f.d});assert.equal(f.store.getCharacter('测试人物'),null);
});

test('人物宏、关键词世界书和上下文字符预算生效',()=>{
  const p=buildPrompt({character:{name:'测试人物',mes_example:'{{char}}对{{user}}说你好',character_book:{entries:[{enabled:true,keys:['练剑'],content:'练剑资料'}]}},userName:'测试者',history:[{role:'user',text:'很旧的文字'.repeat(500)},{role:'user',text:'今天练剑吗'}],maxCharsPerMessage:4000,maxContextChars:2000});
  assert.ok(!p.system.includes('{{char}}'));assert.ok(p.system.includes('测试人物对测试者'));assert.ok(p.system.includes('练剑资料'));assert.equal(p.messages.at(-1).content,'今天练剑吗');assert.ok(Array.from(p.system+p.messages.map(m=>m.content).join('')).length<=2000);
});

test('通知事件默认关闭，启用后去重，撤回清理上下文，不接受好友请求',async t=>{
  const f=fixture(t),group={isGroup:true,groupId:'g'};
  const e=f.event('',{...group,eventType:'notice',noticeType:'group_increase'});
  await f.d.dispatch(e);assert.equal(f.replies.length,0);
  await f.dispatch('!事件设置 on',group);const fresh={...e,eventId:e.eventId+'new'};await f.d.dispatch(fresh);await f.d.dispatch(fresh);assert.equal(f.replies.filter(r=>String(r).includes('欢迎新朋友')).length,1);
  await f.dispatch('!策略设置 all',group);await f.dispatch('群消息',group);assert.ok(f.store.countMessages('mock:999:group:g')>0);
  const recalled=f.store.recentMessages('mock:999:group:g',20).find(r=>r.role==='user').messageId;await f.d.dispatch(f.event('',{...group,eventType:'notice',noticeType:'group_recall',recalledMessageId:recalled}));assert.equal(f.store.countMessages('mock:999:group:g'),0);
  const before=f.replies.length;await f.d.dispatch(f.event('',{eventType:'request'}));assert.equal(f.replies.length,before);
});

test('表情仅能选登记素材，结构化出站，无任意CQ/本地文件注入',async t=>{
  const f=fixture(t,{complete:async()=>({text:'好呀 [sticker:happy]',usage:{input:1,output:1}})});
  await f.dispatch('!表情添加 bad file:///etc/passwd 不允许');assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_stickers').get().n,0);
  await f.dispatch('!表情添加 happy https://cdn.example.com/happy.png 开心');
  await f.dispatch('你好');assert.equal(typeof f.replies.at(-1),'string');
  await f.dispatch('!表情设置 on');await f.dispatch('再聊');const message=f.replies.at(-1);assert.ok(Array.isArray(message.segments));assert.equal(encodeMessage(message)[0].type,'image');
  assert.throws(()=>encodeMessage({segments:[{type:'image',file:'file:///etc/passwd'}]}));
  await f.dispatch('!表情删除 happy');await f.dispatch('还在吗');assert.equal(typeof f.replies.at(-1),'string');
});

test('主动任务默认不存在，持久化同会话目标，安静时段、去重、停用与取消',async t=>{
  const f=fixture(t);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_jobs').get().n,0);
  await f.dispatch('!主动设置 5');f.p.services.scheduler.start();f.advance(6*60000);await f.p.services.scheduler.tick();await f.p.services.engine.drain();
  assert.equal(f.deliveries.length,1);assert.equal(f.deliveries[0].target.userId,'admin');
  await f.p.services.scheduler.tick();await f.p.services.engine.drain();assert.equal(f.deliveries.length,1);
  f.advance(6*60000);await f.dispatch('!策略设置 off');await f.p.services.scheduler.tick();assert.equal(f.deliveries.length,1);
  await f.dispatch('!主动设置 0');assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM chat_jobs').get().n,0);
});

test('显式长期记忆默认不注入，开启/删除/摘要均限定本会话',async t=>{
  const f=fixture(t);await f.dispatch('!记忆添加 喜欢桂花点心');await f.dispatch('今天聊聊');assert.ok(!f.calls.at(-1).messages[0].content.includes('桂花点心'));
  await f.dispatch('!记忆设置 on');await f.dispatch('继续聊');assert.ok(f.calls.at(-1).messages[0].content.includes('桂花点心'));
  await f.dispatch('另一个会话',{unifiedUserId:'mock:other',sender:{id:'other'}});assert.ok(!f.calls.at(-1).messages[0].content.includes('桂花点心'));
  const id=f.store.listMemories('mock:999:private:mock:admin')[0].id;
  await f.dispatch('!记忆删除 '+id,{isGroup:true,groupId:'g'});assert.equal(f.store.listMemories('mock:999:private:mock:admin').length,1);
  await f.dispatch('!记忆删除 '+id);assert.equal(f.store.listMemories('mock:999:private:mock:admin').length,0);
  await f.dispatch('!生成摘要');assert.equal(f.store.getOption('mock:999:private:mock:admin','summary:'),'正常回答');await f.dispatch('!删除摘要');assert.equal(f.store.getOption('mock:999:private:mock:admin','summary:'),'');
});

test('新增管理指令全部保留双管理员鉴权，命名空间修改后提示跟随',async t=>{
  const f=fixture(t);for(const route of f.p.routes.filter(r=>(!r.stage || r.stage==='command') && r.id!=='aiAuth')) {
    const result=await f.dispatch('!'+route.tokens[0],{unifiedUserId:'mock:user',sender:{id:'user'}});assert.equal(result.out.status,'DENIED',route.id);
  }
  f.d.setNamespace('chat-ai',{prefix:'?',aliases:['问问'],priority:50});const settings=await f.dispatch('?设置');assert.ok(settings.text.includes('?连接新增'));assert.ok(!settings.text.includes('!连接新增'));
});


test('健康检查不会把HTML的200当成标准模型列表，同连接只探测一次',async t=>{
  const profile={id:'a',endpoint:'https://api.example.com/v1',model:'model-a',apiKeyEnv:'CHATAI_KEY_DIAG'};
  const bad=await checkSingleProfile(profile,{fetchImpl:async()=>({status:200,json:async()=>({html:'login'})})});assert.equal(bad.status,'未确认');
  const f=fixture(t);f.store.saveModel({...profile,id:'second'});await f.p.start();assert.equal(f.fetches.length,1);
});

test('向导不把误粘贴的模型密钥保存为名称或模型ID',async t=>{
  const f=fixture(t,{withModel:false});await f.dispatch('!连接新增');const bad=await f.dispatch('sk-mistakenly-pasted-secret');assert.match(bad.text,/拒绝保存/);assert.equal(f.store.listConnections().length,0);
  await f.dispatch('取消');await f.dispatch('!模型新增');await f.dispatch('new');await f.dispatch('https://api.example.com/v1');const legacy=await f.dispatch('sk-another-pasted-secret');assert.match(legacy.text,/未保存/);assert.equal(f.store.listModels().length,0);
});

test('主动任务重建恢复且创建者权限撤销后不会继续发送',async t=>{
  const f=fixture(t);await f.dispatch('!主动设置 5');await f.p.stop();
  const replacement=createModule({vault:f.vault,dispatcher:f.d,now:f.now,config:{model:{defaultProfileId:'main'}},fetchImpl:async()=>({ok:true,status:200,json:async()=>({data:[]})})});
  try {
    await replacement.start();f.advance(6*60000);await replacement.services.scheduler.tick();await replacement.services.engine.drain();assert.equal(f.deliveries.length,1);
    f.d.removeAdmin('mock:admin');f.advance(6*60000);await replacement.services.scheduler.tick();await replacement.services.engine.drain();assert.equal(f.deliveries.length,1);
    assert.equal(f.store.db.prepare('SELECT enabled FROM chat_jobs').get().enabled,0);
  } finally {await replacement.stop();}
});

test('主动任务安静时段不发送，停止后不再执行手动tick',async t=>{
  const f=fixture(t);await f.dispatch('!主动设置 5');f.p.services.scheduler.start();f.advance(12*60*60000);await f.p.services.scheduler.tick();await f.p.services.engine.drain();assert.equal(f.deliveries.length,0);
  f.p.services.scheduler.stop();f.advance(12*60*60000);await f.p.services.scheduler.tick();assert.equal(f.deliveries.length,0);
});

test('事件发言关闭时仍清理撤回内容；人物开场白不能注入CQ',async t=>{
  const f=fixture(t);await f.dispatch('被撤回的问题');const sid='mock:999:private:mock:admin';
  const recalled=f.store.recentMessages(sid,20).find(r=>r.role==='user').messageId;await f.d.dispatch(f.event('',{eventType:'notice',noticeType:'friend_recall',recalledMessageId:recalled}));assert.equal(f.store.countMessages(sid),0);
  const before=f.replies.length;assert.ok(!f.replies.slice(before).some(x=>String(x).includes('撤回')));
  f.store.saveCharacter({id:'old-card',name:'旧卡',card:{name:'旧卡',first_mes:'hello [CQ:at,qq=all]'}});
  const greeting=await f.dispatch('!人物切换 old-card');assert.ok(!greeting.text.includes('[CQ:'));
});

test('真实反向WS网关接收notice并以标准图片消息段交付回复',async t=>{
  let received,resolveDone,rejectDone;
  const done=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
  const gateway=new NapCatGateway({host:'127.0.0.1',port:0,accessToken:'diagnostic',dispatcher:{dispatch:async event=>{try {received=event;const result=await event.reply({segments:[{type:'text',text:'问候'},{type:'image',file:'https://cdn.example.com/ok.png'}]});assert.equal(result.success,true);resolveDone();}catch(e){rejectDone(e);}}}});
  await gateway.start();const ws=new WebSocket(`ws://127.0.0.1:${gateway.server.address().port}/onebot/v11/ws`,{headers:{Authorization:'Bearer diagnostic'}});
  t.after(async()=>{ws.terminate();await gateway.stop();});
  ws.on('message',data=>{const request=JSON.parse(String(data));try {assert.equal(request.action,'send_msg');assert.equal(request.params.message[1].type,'image');ws.send(JSON.stringify({echo:request.echo,status:'ok',retcode:0,data:{message_id:123}}));}catch(e){rejectDone(e);}});
  await once(ws,'open');ws.send(JSON.stringify({post_type:'notice',notice_type:'notify',sub_type:'poke',self_id:999,user_id:123,target_id:999,group_id:456,time:1793073600}));
  const timer=setTimeout(()=>rejectDone(new Error('gateway notice timeout')),2000);
  try {await done;assert.equal(received.eventType,'notice');assert.equal(received.platform,'qq-napcat');assert.equal(received.mentionedBot,false);assert.equal(received.targetUserId,'999');}finally{clearTimeout(timer);}
});


test('默认模型编号选择确实修改全局默认，详情参数写错不静默回退',async t=>{
  const f=fixture(t);f.store.saveModel({id:'b',label:'第二个',connectionId:f.store.getModel('main').connectionId,model:'model-b'});
  const list=await f.dispatch('!默认模型');const number=/(\d+)\. 第二个/.exec(list.text)[1];await f.dispatch(number);assert.equal(f.store.getSetting('defaultModel'),'b');assert.equal(f.store.getSession('mock:999:private:mock:admin')?.modelProfileId ?? null,null);
  const info=await f.dispatch('!模型详情 不存在');assert.match(info.text,/未找到/);
  await f.dispatch('!模型参数 main __proto__ 1');assert.equal(f.store.getModel('main').temperature,null);
});

test('开启新配置向导会结束旧向导，配置输入不会污染聊天历史',async t=>{
  const f=fixture(t,{withModel:false});await f.dispatch('!模型新增');await f.dispatch('old');
  await f.dispatch('!连接新增');await f.dispatch('新服务');await f.dispatch('https://api.example.com/v1');await f.dispatch('CHATAI_KEY_DIAG');await f.dispatch('确认');assert.equal(f.store.listConnections().length,1);assert.equal(f.store.listModels().length,0);
  await f.dispatch('!连接新增');await f.dispatch('!模型新增');await f.dispatch('new');await f.dispatch('https://api.example.com/v1');await f.dispatch('model-a');await f.dispatch('CHATAI_KEY_DIAG');await f.dispatch('确认并使用');
  assert.equal(f.store.countMessages('mock:999:private:mock:admin'),0);await f.dispatch('新问题');assert.equal(f.calls.length,1);
});
