import test from "node:test";
import assert from "node:assert/strict";
import {GameHubDispatcher, IdentityVault} from "../packages/core/src/index.mjs";
import {createModule} from "../packages/plugin/chat-ai/src/index.mjs";
import {clearAllDrafts} from "../packages/plugin/chat-ai/src/wizard.mjs";

let sequence = 0;
const event = (text, overrides = {}) => ({
  eventId: "ev-" + (++sequence),
  messageId: "msg-" + sequence,
  platform: "mock",
  botId: "999",
  unifiedUserId: "mock:admin",
  cleanText: text,
  sender: {id: "admin", name: "管理员"},
  reply: async () => ({success: true}),
  ...overrides
});

const setup = ({vault, config = {}, now = Date.now} = {}) => {
  clearAllDrafts();
  const dispatcher = new GameHubDispatcher({vault, adminToken: "hub-secret"});
  dispatcher.addAdmin("mock:admin");
  const module = createModule({config, vault, dispatcher, now});
  dispatcher.registerPlugin(module);
  const replies = [];
  const dispatch = async (text, overrides = {}) => {
    const before = replies.length;
    const output = await dispatcher.dispatch(event(text, {
      reply: async message => { replies.push(String(message)); return {success: true}; },
      ...overrides
    }));
    return {status: output.status, reply: replies.slice(before).join("\n")};
  };
  return {dispatcher, module, store: module.services.store, replies, dispatch};
};

const connection = (store, id = "service") => store.saveConnection({id,label:id,endpoint:"https://api.example.com/v1",apiKeyEnv:"CHATAI_KEY_MAIN"});

test("模型新增复用已有连接，只询问上游模型和显示名称，输入不进入上下文", async t => {
  const vault = new IdentityVault(); t.after(()=>vault.close());
  const {dispatch,store} = setup({vault}); connection(store);
  assert.match((await dispatch("!模型新增 service")).reply,/模型 ID/);
  await dispatch("upstream-model");
  assert.match((await dispatch("日常聊天")).reply,/确认/);
  await dispatch("确认");
  const saved=store.listModels()[0];
  assert.equal(saved.model,"upstream-model"); assert.equal(saved.label,"日常聊天");
  assert.equal(saved.connectionId,"service"); assert.equal(store.listConnections().length,1);
  assert.equal(store.countMessages("mock:999:private:mock:admin"),0);
});

test("新增模型校验、取消和多连接选择，不创建隐式服务",async t=>{
  const vault=new IdentityVault();t.after(()=>vault.close());const {dispatch,store}=setup({vault});
  assert.match((await dispatch("!模型新增")).reply,/连接新增/);
  assert.equal(store.listConnections().length,0);
  connection(store,"a");connection(store,"b");
  assert.match((await dispatch("!模型新增")).reply,/服务连接/);
  await dispatch("!模型新增 a");
  assert.match((await dispatch("x".repeat(129))).reply,/1至128/);
  assert.match((await dispatch("sk-pasted-secret")).reply,/拒绝保存/);
  await dispatch("取消");assert.equal(store.listModels().length,0);
  await dispatch("!模型新增 b");await dispatch("model-b");await dispatch("第二个");await dispatch("确认");
  assert.equal(store.listModels()[0].connectionId,"b");
});

test("模型修改仅改变上游模型ID，保留共享连接、其他模型及参数",async t=>{
  const vault=new IdentityVault();t.after(()=>vault.close());const {dispatch,store}=setup({vault});connection(store);
  store.saveModel({id:"edit",label:"日常",connectionId:"service",model:"before",temperature:0.7,maxContextChars:30000});
  store.saveModel({id:"other",connectionId:"service",model:"other"});
  const service=store.getConnection("service"),other=store.getModel("other");
  assert.match((await dispatch("!模型修改")).reply,/!模型修改 <模型名称或ID>/);
  assert.match((await dispatch("!模型修改 missing")).reply,/未找到唯一/);
  assert.match((await dispatch("!模型修改 日常")).reply,/上游模型 ID/);
  await dispatch("after");assert.match((await dispatch("确认")).reply,/模型修改成功/);
  assert.equal(store.getModel("edit").model,"after");assert.equal(store.getModel("edit").temperature,0.7);
  assert.equal(store.getModel("edit").maxContextChars,30000);
  assert.deepEqual(store.getConnection("service"),service);assert.deepEqual(store.getModel("other"),other);
  await dispatch("!模型修改 edit");await dispatch("跳过");await dispatch("确认");assert.equal(store.getModel("edit").model,"after");
});

test("模型修改保存时保留并发服务与参数修改，拒绝覆盖已删除或被改写的模型",async t=>{
  const vault=new IdentityVault();t.after(()=>vault.close());const {dispatch,store}=setup({vault});connection(store);
  store.saveModel({id:"edit",connectionId:"service",model:"before"});
  await dispatch("!模型修改 edit");await dispatch("after");
  store.saveConnection({...store.getConnection("service"),endpoint:"https://new.example.com/v1",apiKeyEnv:"CHATAI_KEY_NEW"});
  store.saveModel({...store.getModel("edit"),temperature:1.2});await dispatch("确认");
  assert.equal(store.getModel("edit").endpoint,"https://new.example.com/v1");
  assert.equal(store.getModel("edit").apiKeyEnv,"CHATAI_KEY_NEW");assert.equal(store.getModel("edit").temperature,1.2);
  await dispatch("!模型修改 edit");await dispatch("stale");store.deleteModel("edit");
  assert.match((await dispatch("确认")).reply,/已被删除或修改/);assert.equal(store.getModel("edit"),null);
  store.saveModel({id:"edit",connectionId:"service",model:"before"});
  await dispatch("!模型修改 edit");await dispatch("stale");store.saveModel({...store.getModel("edit"),model:"newer"});
  await dispatch("确认");assert.equal(store.getModel("edit").model,"newer");
});

test("模型修改支持取消、重来、群聊拒绝、TTL到期及权限撤销",async t=>{
  const vault=new IdentityVault();t.after(()=>vault.close());let time=1000000;
  const {dispatcher,dispatch,store}=setup({vault,now:()=>time});connection(store);
  store.saveModel({id:"edit",connectionId:"service",model:"before"});
  assert.match((await dispatch("!模型修改 edit",{isGroup:true,groupId:"g"})).reply,/私聊/);
  await dispatch("!模型修改 edit");await dispatch("candidate");await dispatch("重来");await dispatch("取消");
  assert.equal(store.getModel("edit").model,"before");
  await dispatch("!模型修改 edit");time+=11*60*1000;await dispatch("after-timeout");
  assert.equal(store.getModel("edit").model,"before");
  await dispatch("!模型修改 edit");dispatcher.removeAdmin("mock:admin");
  assert.match((await dispatch("after-revoke")).reply,/管理员权限已失效/);
  assert.equal(store.getModel("edit").model,"before");
});
