import test from "node:test";
import assert from "node:assert/strict";
import {IdentityVault,GameHubDispatcher,InboundShaper} from "../packages/core/src/index.mjs";
import {createModule} from "../packages/plugin/chat-ai/src/index.mjs";
import {parseCharacterCard,MAX_CARD_BYTES} from "../packages/plugin/chat-ai/src/character.mjs";
import {OneBotRpcManager} from "../packages/channel/napcat/src/rpc.mjs";
import {deliver,readAttachment} from "../packages/channel/napcat/src/files.mjs";
import {availableAssets,saveAsset} from "../packages/plugin/chat-ai/src/assets.mjs";
import {parseReplyPlan} from "../packages/plugin/chat-ai/src/reply-plan.mjs";
import {NapCatGateway} from "../packages/channel/napcat/src/server.mjs";
import WebSocket from "ws";
import {once} from "node:events";
let sequence=0;
const SID="mock:bot:private:mock:admin";
function fixture(t,complete=async()=>({text:"回答"})) {
  const vault=new IdentityVault(":memory:"),d=new GameHubDispatcher({vault,adminUsers:["mock:admin"]}),replies=[],calls=[];
  let time=100000;
  d.registerProvider({id:"llm",capabilities:["chat"],createClient:()=>({complete:async input=>{calls.push(input);return complete(input);}})});
  const p=createModule({vault,dispatcher:d,now:()=>time,config:{model:{defaultProfileId:"main"}}});d.registerPlugin(p);
  const store=p.services.store;
  store.saveCharacter({id:"测试人物",name:"测试人物",card:{name:"测试人物",description:"独立构造的通用测试角色，无私人设定。",first_mes:"你好，这是测试问候。"},owner:"test-fixture"});
  store.saveModel({id:"main",endpoint:"https://api.example.com/v1",model:"example",apiKeyEnv:"CHATAI_TEST_KEY"});
  const event=(text="",extra={})=>({eventId:"evt"+(++sequence),messageId:String(sequence),platform:"mock",botId:"bot",unifiedUserId:"mock:admin",sender:{id:"admin",name:"管理员"},cleanText:text,reply:async content=>{replies.push(content);return {success:true,messageId:"out"+(++sequence)};},...extra});
  const dispatch=async(text,extra={})=>{const result=await d.dispatch(event(text,extra));await p.services.engine.drain();return result;};
  t.after(async()=>{await p.stop();vault.close();});
  const attachment=(text,name="人物.txt",extra={})=>({eventType:"notice",noticeType:"offline_file",attachments:[{id:"qq-file-id",name,size:Buffer.byteLength(text),type:"file",readBytes:async()=>Buffer.from(text),...extra}]});
  return {vault,d,p,store,event,dispatch,replies,calls,attachment,advance:ms=>time+=ms};
}

test("TXT/Markdown完整保留长卡与UTF8 BOM，JSON设定和世界书不截断",()=>{
  const source="# 角色卡：长卡 —— 示例\n"+"细节\n".repeat(4000)+"末尾内容";
  const parsed=parseCharacterCard("\uFEFF"+source,{filename:"long.txt"});assert.equal(parsed.card.name,"长卡");assert.equal(parsed.card.description,source);
  const data={name:"长卡",description:"x".repeat(70000),character_book:{entries:[{content:"y".repeat(5000),keys:["触发"],extra:1}]}};
  const result=parseCharacterCard({spec:"chara_card_v2",data});assert.deepEqual(result.card.character_book,data.character_book);assert.equal(result.card.description,data.description);
  assert.equal(parseCharacterCard(JSON.stringify(data),{filename:"card.txt"}).card.description,data.description);
  assert.throws(()=>parseCharacterCard("x".repeat(MAX_CARD_BYTES+1)),/1 MiB/);
});
test("私聊指令后独立文件导入→分页预览→完整JSON文件导出，不污染历史",async t=>{
  const f=fixture(t),source="# 角色卡：文件卡 —— 示例\n"+"完整设定。".repeat(3000);
  await f.dispatch("!人物导入");await f.dispatch("",f.attachment(source));
  assert.equal(f.store.getCharacter("文件卡").card.description,source);assert.equal(f.store.countMessages(SID),0);
  await f.dispatch("!人物预览 文件卡 2");assert.match(f.replies.at(-1),/第2\//);assert.ok(f.replies.at(-1).length<2100);
  await f.dispatch("!人物导出 文件卡");const exported=f.replies.at(-1);assert.equal(exported.files[0].name,"文件卡.json");assert.equal(JSON.parse(exported.files[0].data).data.description,source);
  await f.dispatch("!人物覆盖 文件卡");await f.dispatch("",f.attachment("# 文件卡\n新设定"));assert.equal(f.store.getCharacter("文件卡").card.description,"# 文件卡\n新设定");
});
test("文件导入隔离机器人/用户/群聊，并在读取前检查大小、读取后复核权限",async t=>{
  const f=fixture(t);await f.dispatch("!人物导入");let reads=0;
  const extra=f.attachment("# 隔离卡",undefined,{readBytes:async()=>{reads++;return Buffer.from("# 隔离卡");}});
  for(const identity of [{botId:"other"},{unifiedUserId:"mock:other",sender:{id:"other"}},{isGroup:true,groupId:"g"}])await f.dispatch("",{...extra,...identity});assert.equal(reads,0);
  await f.dispatch("",f.attachment("",undefined,{size:MAX_CARD_BYTES+1,readBytes:async()=>{reads++;}}));assert.equal(reads,0);
  let release;const gate=new Promise(r=>release=r);
  const task=f.d.dispatch(f.event("",f.attachment("",undefined,{readBytes:async()=>{await gate;return Buffer.from("# 隔离卡");}})));
  f.d.adminUsers.clear();release();await task;assert.equal(f.store.getCharacter("隔离卡"),null);
});
test("导入超时、取消与另开向导不消耗后续文件",async t=>{
  const f=fixture(t);let reads=0;const extra=f.attachment("# 测试卡",undefined,{readBytes:async()=>{reads++;return Buffer.from("# 测试卡");}});
  await f.dispatch("!人物导入");f.advance(600001);await f.dispatch("",extra);assert.equal(reads,0);
  await f.dispatch("!人物导入");await f.dispatch("取消");await f.dispatch("",extra);assert.equal(reads,0);
  await f.dispatch("!人物导入");await f.dispatch("!连接新增");await f.dispatch("",extra);assert.equal(reads,0);
});
test("OneBot私聊/群文件与图片段有惰性附件读取，撤回引用独立字段",()=>{
  let reads=0;const options={readAttachment:async()=>{reads++;return Buffer.from("x");}};
  const e=InboundShaper.shape({post_type:"notice",notice_type:"offline_file",user_id:1,self_id:2,file:{id:"x",name:"card.txt",size:30}},options);
  assert.equal(e.attachments[0].name,"card.txt");assert.equal(reads,0);assert.equal(typeof e.attachments[0].readBytes,"function");
  const r=InboundShaper.shape({post_type:"notice",notice_type:"friend_recall",message_id:111,user_id:1,self_id:2});assert.equal(r.recalledMessageId,"111");
  const cq=InboundShaper.shape({post_type:"message",user_id:1,self_id:2,message:"[CQ:file,file_id=uuid,name=卡&#44;片.txt,file_size=123]"},options);assert.equal(cq.attachments[0].id,"uuid");assert.equal(cq.attachments[0].name,"卡,片.txt");assert.equal(cq.attachments[0].size,123);
});
test("流式附件等待全部分片、校验顺序/大小/完成计数，并隔离连接echo",async()=>{
  const rpc=new OneBotRpcManager();let request;const ws={readyState:1,send:raw=>request=JSON.parse(raw)},other={};
  const result=rpc.downloadFile(ws,"uuid",20,1000),echo=request.echo;
  const send=data=>rpc.handleIncoming({echo,status:"ok",retcode:0,stream:"stream-action",data},ws);
  assert.equal(rpc.handleIncoming({echo,status:"ok",data:{}},other),false);
  send({data_type:"file_info",file_size:5});send({data_type:"file_chunk",index:0,data:Buffer.from("hello").toString("base64"),size:5});
  assert.equal(rpc.pendingCalls.size,1);send({data_type:"file_complete",total_chunks:1,total_bytes:5});assert.equal((await result).toString(),"hello");assert.equal(rpc.pendingCalls.size,0);
  const bad=rpc.downloadFile(ws,"uuid",3,1000);rpc.handleIncoming({echo:request.echo,status:"ok",data:{data_type:"file_info",file_size:4}},ws);await assert.rejects(bad,/无效/);
  const order=rpc.downloadFile(ws,"uuid",20,1000);rpc.handleIncoming({echo:request.echo,data:{data_type:"file_info",file_size:5}},ws);rpc.handleIncoming({echo:request.echo,data:{data_type:"file_chunk",index:1,data:"aGVsbG8=",size:5}},ws);await assert.rejects(order,/无效/);
  await assert.rejects(rpc.downloadFile(ws,"uuid",20,5),/超时/);assert.equal(rpc.pendingCalls.size,0);
});
test("跨容器文件不读取本地路径、不抓取任意URL，旧桥仅接受有界base64",async()=>{
  let calls=0;const rpc={downloadFile:async()=>{throw Object.assign(new Error("unsupported"),{code:"ONEBOT_API_FAILED"});},callApi:async()=>{calls++;return {data:{file:"/bridge/private/card.txt",url:"http://127.0.0.1/secret"}};}};
  await assert.rejects(readAttachment(rpc,{}, {id:"uuid"}),/Stream API/);assert.equal(calls,1);
  await assert.rejects(readAttachment(rpc,{}, {id:"file:///etc/passwd"}),/文件 ID/);assert.equal(calls,1);
  rpc.callApi=async()=>({data:{base64:"aGVsbG8="}});assert.equal((await readAttachment(rpc,{}, {id:"uuid"})).toString(),"hello");
});
test("QQ文字和文件分成原生调用，有序等待交付；部分失败不盲目重发",async()=>{
  const calls=[],rpc={callApi:async(ws,action,params)=>{calls.push({action,params});if(action.includes("upload"))throw Error("failed");return {data:{message_id:123}};}};
  const result=await deliver(rpc,{}, {userId:"1",isGroup:false},{text:"说明",files:[{name:"card.json",data:Buffer.from("{}")}]});
  assert.deepEqual(calls.map(c=>c.action),["send_msg","upload_private_file"]);assert.equal(calls[1].params.file,"base64://e30=");assert.equal(result.partial,true);assert.equal(result.partsDelivered,1);
  calls.length=0;await deliver({callApi:async(ws,action,params)=>{calls.push({action,params});return {data:{message_id:1}};}},{},{userId:"1"},"长".repeat(6000));assert.equal(calls.length,3);assert.equal(calls[2].params.message.length,1000);
});
test("精确撤回保留其它对话，删除依赖回答，只失效引用该消息的摘要",async t=>{
  const f=fixture(t);await f.dispatch("要撤回",{messageId:"first"});await f.dispatch("保留消息",{messageId:"second"});
  const first=f.store.recentMessages(SID,20).find(r=>r.messageId==="first");
  f.store.setOption(SID,"summary:","相关摘要");f.store.setOption(SID,"summarySources:",[first.seq]);
  await f.dispatch("",{eventType:"notice",noticeType:"friend_recall",recalledMessageId:"first"});
  const rows=f.store.recentMessages(SID,20);assert.equal(rows.length,1);assert.equal(rows[0].text,"保留消息");assert.equal(f.store.getOption(SID,"summary:",null),"");
  await f.dispatch("",{eventType:"notice",noticeType:"friend_recall",recalledMessageId:"unknown"});assert.equal(f.store.countMessages(SID),1);
});
test("早到撤回阻止原消息重入；裁剪后仍可定位摘要来源",async t=>{
  const f=fixture(t);await f.dispatch("先存在");await f.dispatch("",{eventType:"notice",noticeType:"friend_recall",recalledMessageId:"late"});await f.dispatch("不应入库",{messageId:"late"});assert.ok(!f.store.recentMessages(SID,20).some(r=>r.text==="不应入库"));
  await f.dispatch("摘要来源",{messageId:"pruned"});const row=f.store.recentMessages(SID,20).find(r=>r.messageId==="pruned");f.store.setOption(SID,"summary:","摘要");f.store.setOption(SID,"summarySources:",[row.seq]);f.store.pruneMessages(SID,0);
  await f.dispatch("",{eventType:"notice",noticeType:"friend_recall",recalledMessageId:"pruned"});assert.equal(f.store.getOption(SID,"summary:",null),"");
});
test("等待人物文件期间仍处理撤回，不让上传流程吞掉通知",async t=>{
  const f=fixture(t);await f.dispatch("要撤回",{messageId:"during-upload"});await f.dispatch("!人物导入");
  await f.dispatch("",{eventType:"notice",noticeType:"friend_recall",recalledMessageId:"during-upload"});assert.equal(f.store.countMessages(SID),0);
  await f.dispatch("",f.attachment("# 通知后卡"));assert.ok(f.store.getCharacter("通知后卡"));
});
test("长卡存储独立于注入预算，模型上下文参数可通过管理员命令修改并查看",async t=>{
  const f=fixture(t);await f.dispatch('!人物导入 '+JSON.stringify({name:"长卡",description:"人设".repeat(6000)+"最后的设定"}));await f.dispatch("!人物切换 长卡");
  await f.dispatch("!模型参数 main 上下文 30000");assert.equal(f.store.getModel("main").maxContextChars,30000);await f.dispatch("!模型详情");assert.match(f.replies.at(-1),/30000字符/);
  await f.dispatch("问题");assert.ok(f.calls.at(-1).messages[0].content.includes("最后的设定"));assert.equal(f.store.getCharacter("长卡").card.description.length,12005);
});
test("撤回中止依赖原文的进行中生成，模型无视abort的迟到结果也不发送",async t=>{
  let release;const f=fixture(t,async()=>{await new Promise(r=>release=r);return {text:"迟到结果"};});
  await f.d.dispatch(f.event("敏感问题",{messageId:"active"}));
  await f.d.dispatch(f.event("",{eventType:"notice",noticeType:"friend_recall",recalledMessageId:"active"}));release();await f.p.services.engine.drain();assert.ok(!f.replies.includes("迟到结果"));assert.equal(f.store.countMessages(SID),0);
});
test("撤回不取消未使用目标消息的任务，也不清除无关摘要或其它人物历史",async t=>{
  let release,number=0;const f=fixture(t,async()=>{if(++number===2)await new Promise(r=>release=r);return {text:"答"+number};});
  await f.dispatch("旧问题",{messageId:"old"});f.store.pruneMessages(SID,0);
  f.store.setOption(SID,"summary:","独立摘要");f.store.setOption(SID,"summarySources:",[]);
  await f.d.dispatch(f.event("新问题",{messageId:"new"}));
  await f.d.dispatch(f.event("",{eventType:"notice",noticeType:"friend_recall",recalledMessageId:"old"}));
  release();await f.p.services.engine.drain();assert.ok(f.replies.includes("答2"));assert.equal(f.store.getOption(SID,"summary:",null),"独立摘要");
  await f.dispatch("!人物切换 测试人物");const other=f.store.countMessages(SID);
  await f.dispatch("",{eventType:"notice",noticeType:"friend_recall",recalledMessageId:"new"});assert.equal(f.store.countMessages(SID),other);
});
test("关闭人物事件时取消旧事件输出，已发起调用仍计入额度",async t=>{
  let release;const f=fixture(t,async()=>{await new Promise(r=>release=r);return {text:"旧事件输出"};});
  await f.dispatch("!事件设置 poke persona");
  await f.d.dispatch(f.event("",{eventType:"notice",noticeType:"notify",noticeSubtype:"poke",targetUserId:"bot"}));
  await f.d.dispatch(f.event("!事件设置 off"));release();await f.p.services.engine.drain();assert.ok(!f.replies.includes("旧事件输出"));assert.equal(f.calls.length,1);assert.equal(f.store.db.prepare("SELECT requests FROM chat_usage WHERE session_id=?").get(SID).requests,1);
});
test("表情文件上传、同图去重、标签人物筛选、原子素材包导入和替换",async t=>{
  const f=fixture(t),bytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==","base64");
  await f.dispatch("!表情添加 happy 开心");await f.dispatch("",f.attachment("","happy.png",{size:bytes.length,readBytes:async()=>bytes}));
  assert.match(f.store.db.prepare("SELECT file FROM chat_stickers WHERE id='happy'").get().file,/^base64:/);
  await f.dispatch("!表情标签 happy 开心,微笑 测试人物");assert.equal(availableAssets(f.store,"").length,0);assert.equal(availableAssets(f.store,"测试人物").length,1);
  assert.throws(()=>saveAsset(f.store,{id:"duplicate",label:"重复",file:"base64://"+bytes.toString("base64")}),/相同图片/);
  await f.dispatch("!表情替换 happy");await f.dispatch("",f.attachment("","happy.png",{readBytes:async()=>bytes}));assert.equal(availableAssets(f.store,"测试人物")[0].tags[0],"开心");
  await f.dispatch("!表情导入");await f.dispatch("",f.attachment(JSON.stringify({assets:[{id:"new",label:"新",file:"https://cdn.example.com/a.png"},{id:"happy",label:"重复ID",file:"https://cdn.example.com/a.png"}]}),"assets.json"));assert.equal(f.store.db.prepare("SELECT id FROM chat_stickers WHERE id='new'").get(),undefined);
});
test("只发表情、独立气泡与冷却，模型任意路径/未知动作不获执行",async t=>{
  const f=fixture(t,async()=>({text:"[sticker:happy]"}));await f.dispatch("!表情添加 happy https://cdn.example.com/a.png 开心");await f.dispatch("!表情设置 on");const start=f.replies.length;
  await f.dispatch("你好");assert.equal(f.replies.length,start+1);assert.deepEqual(f.replies.at(-1).segments.map(s=>s.type),["image"]);
  await f.dispatch("再来");assert.equal(f.replies.length,start+1);
  assert.deepEqual(parseReplyPlan('{"actions":[{"type":"rpc","action":"delete"}]}'),[]);
  assert.deepEqual(parseReplyPlan("[sticker:unknown]",{assets:[{id:"happy"}]}),[]);
});
test("人物事件按类型开启、冷却合并突发、允许沉默，不伪造用户历史",async t=>{
  const f=fixture(t,async()=>({text:"（回过头）怎么啦？"}));
  const notice={eventType:"notice",noticeType:"notify",noticeSubtype:"poke",targetUserId:"bot"};
  await f.dispatch("",notice);assert.equal(f.calls.length,0);
  await f.dispatch("!人物切换 测试人物");await f.dispatch("!事件设置 poke persona");const users=f.store.recentMessages(SID,20).filter(r=>r.role==="user").length;
  await f.dispatch("",notice);await f.dispatch("",notice);assert.equal(f.calls.length,1);assert.match(f.calls[0].messages[0].content,/当前人物|角色|测试人物/);assert.match(f.calls[0].messages[0].content,/渠道通知/);assert.equal(f.store.recentMessages(SID,20).filter(r=>r.role==="user").length,users);
  await f.dispatch("!事件设置 off");f.advance(60000);await f.dispatch("",notice);assert.equal(f.calls.length,1);
});
test("人物事件可以不回复，模板不调用模型；卡内工具声明不改变宿主能力",async t=>{
  const f=fixture(t,async()=>({text:"[不回复]"}));await f.dispatch("!事件设置 poke persona");const start=f.replies.length;
  await f.dispatch("",{eventType:"notice",noticeType:"notify",noticeSubtype:"poke",targetUserId:"bot"});assert.equal(f.replies.length,start);assert.equal(f.calls.length,1);
  await f.dispatch("!事件设置 join template 欢迎来到这里");f.advance(60000);await f.dispatch("",{eventType:"notice",noticeType:"group_increase"});assert.equal(f.replies.at(-1),"欢迎来到这里");assert.equal(f.calls.length,1);
  assert.match(f.calls[0].messages[0].content,/没有联网搜索、视频解析、QQ收藏/);
});

test("真实反向WS：指令→独立离线文件通知→流下载→落库→说明和文件分开发送",async t=>{
  const f=fixture(t);f.d.adminUsers.add("qq-napcat:123");
  const source=Buffer.from("# 角色卡：跨容器卡\n"+"长设定。".repeat(1600)),waiters=new Map(),requests=[];
  const gateway=new NapCatGateway({port:0,host:"127.0.0.1",accessToken:"test-file-token",dispatcher:{dispatch:async e=>{
    const key=e.attachments?.[0]?.name || e.messageId;
    try{await f.d.dispatch(e);waiters.get(key)?.resolve();}catch(error){waiters.get(key)?.reject(error);}
  }}});
  await gateway.start();
  const ws=new WebSocket(`ws://127.0.0.1:${gateway.server.address().port}/onebot/v11/ws`,{headers:{Authorization:"Bearer test-file-token"}});
  t.after(async()=>{ws.terminate();await gateway.stop();});
  ws.on("message",raw=>{
    const request=JSON.parse(raw);requests.push(request);
    const respond=data=>ws.send(JSON.stringify({echo:request.echo,status:"ok",retcode:0,data}));
    if(request.action==="download_file_stream") {
      respond({type:"stream",data_type:"file_info",file_name:"card.txt",file_size:source.length});
      const parts=[source.subarray(0,1000),source.subarray(1000)];
      parts.forEach((part,index)=>respond({type:"stream",data_type:"file_chunk",index,data:part.toString("base64"),size:part.length}));
      respond({type:"response",data_type:"file_complete",total_chunks:parts.length,total_bytes:source.length});
    } else respond({message_id:sequence++});
  });
  await once(ws,"open");
  const send=async(payload,key)=>{
    let timeout;try{await new Promise((resolve,reject)=>{waiters.set(key,{resolve,reject});timeout=setTimeout(()=>reject(Error("WS file test timeout")),2000);ws.send(JSON.stringify({self_id:999,user_id:123,...payload}));});}finally{clearTimeout(timeout);waiters.delete(key);}
  };
  await send({post_type:"message",message_type:"private",message_id:1,message:"!人物导入"},"1");
  await send({post_type:"notice",notice_type:"offline_file",time:200000,file:{id:"registered-uuid",name:"card.txt",size:source.length}},"card.txt");
  assert.equal(f.store.getCharacter("跨容器卡").card.description,source.toString());
  await send({post_type:"message",message_type:"private",message_id:2,message:"!人物导出 跨容器卡"},"2");
  const actions=requests.map(r=>r.action);assert.ok(actions.includes("download_file_stream"));assert.deepEqual(actions.slice(-2),["send_msg","upload_private_file"]);
  const upload=requests.at(-1);assert.equal(upload.params.user_id,"123");const exported=JSON.parse(Buffer.from(upload.params.file.slice(9),"base64"));assert.equal(exported.data.description,source.toString());assert.equal(gateway.rpc.pendingCalls.size,0);
});
