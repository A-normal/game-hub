import test from "node:test";
import assert from "node:assert/strict";
import {GameHubDispatcher, InboundShaper, logger} from "../packages/core/src/index.mjs";

// observer 失败会走 logger.warn；保留捕获断言，同时避免污染测试输出。
logger.setLevel("SILENT");

/** 构造最小可路由事件；reply 计数由各用例按需覆盖。 */
const event = (text, overrides = {}) => ({cleanText:text, unifiedUserId:"test:1", platform:"test", sender:{id:"1"}, reply:async()=>({success:true}), ...overrides});

test("observer 在 text 之后、fallback 之前执行，且 dispatch 仍返回 fallback 的结果", async () => {
  const d = new GameHubDispatcher(); const order = [];
  d.registerPlugin({id:"text-plugin", name:"Text", defaultNamespace:{prefix:"!"}, routes:[
    // 返回 false = NOT_MATCHED：text 阶段被调用但不消费事件，才能观察到后续阶段的相对顺序。
    {id:"text", stage:"text", action:()=>{order.push("text"); return false;}}
  ]});
  d.registerPlugin({id:"observer-plugin", name:"Observer", defaultNamespace:{prefix:";"}, routes:[
    {id:"observe", stage:"observer", action:()=>{order.push("observer"); return {status:"HANDLED"};}}
  ]});
  d.registerPlugin({id:"fallback-plugin", name:"Fallback", defaultNamespace:{prefix:">"}, routes:[
    {id:"fallback", stage:"fallback", action:()=>{order.push("fallback"); return {status:"HANDLED"};}}
  ]});
  const output = await d.dispatch(event("普通文本"));
  assert.deepEqual(order, ["text", "observer", "fallback"]);
  assert.equal(output.status, "HANDLED");
  // 多个 observer 按插件注册顺序执行，且彼此之间不中断。
  const second = [];
  d.registerPlugin({id:"observer-extra", name:"Extra", defaultNamespace:{prefix:"^"}, routes:[
    {id:"observe", stage:"observer", action:()=>{second.push("extra");}}
  ]});
  await d.dispatch(event("再一次"));
  assert.deepEqual(second, ["extra"]);
});

test("observer 抛错：dispatch 不抛、状态不变、其它 observer 与 fallback 仍执行、且不回复错误提示", async () => {
  const d = new GameHubDispatcher(); const order = []; const replies = []; const warnings = [];
  d.registerPlugin({id:"first", name:"First", defaultNamespace:{prefix:"!"}, routes:[
    {id:"observe", stage:"observer", action:()=>{order.push("first"); throw Object.assign(new Error("boom ltoken=abc123"), {code:"DETONATE"});}}
  ]});
  d.registerPlugin({id:"second", name:"Second", defaultNamespace:{prefix:";"}, routes:[
    {id:"observe", stage:"observer", action:()=>{order.push("second");}}
  ]});
  d.registerPlugin({id:"fallback", name:"Fallback", defaultNamespace:{prefix:">"}, routes:[
    {id:"fallback", stage:"fallback", action:()=>{order.push("fallback"); return {status:"HANDLED"};}}
  ]});
  const originalWarn = logger.warn;
  logger.warn = (tag, message) => warnings.push({tag, message:String(message)});
  let output;
  try {
    output = await d.dispatch(event("普通文本", {reply:async value=>{replies.push(String(value)); return {success:true};}}));
  } finally { logger.warn = originalWarn; }
  assert.deepEqual(order, ["first", "second", "fallback"]);
  assert.equal(output.status, "HANDLED");
  assert.deepEqual(replies, []);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].tag, "Dispatcher");
  assert.match(warnings[0].message, /观察器失败: first:observe/);
  assert.match(warnings[0].message, /ltoken=\*\*\*/);
  assert.ok(!warnings[0].message.includes("abc123"));
});

test("observer 返回 HANDLED/DENIED 不影响 dispatch 结果，也不阻止 fallback", async () => {
  const d = new GameHubDispatcher(); const calls = [];
  d.registerPlugin({id:"handled", name:"Handled", defaultNamespace:{prefix:"!"}, routes:[
    {id:"observe", stage:"observer", action:()=>{calls.push("handled"); return {status:"HANDLED"};}}
  ]});
  d.registerPlugin({id:"denied", name:"Denied", defaultNamespace:{prefix:";"}, routes:[
    {id:"observe", stage:"observer", action:()=>{calls.push("denied"); return {status:"DENIED"};}}
  ]});
  d.registerPlugin({id:"fallback", name:"Fallback", defaultNamespace:{prefix:">"}, routes:[
    {id:"fallback", stage:"fallback", action:()=>{calls.push("fallback"); return {status:"HANDLED"};}}
  ]});
  assert.equal((await d.dispatch(event("普通文本"))).status, "HANDLED");
  assert.deepEqual(calls, ["handled", "denied", "fallback"]);
  // 没有 fallback 时，observer 的 HANDLED 也不能把结果变成 HANDLED。
  const alone = new GameHubDispatcher();
  alone.registerPlugin({id:"solo", name:"Solo", defaultNamespace:{prefix:"!"}, routes:[
    {id:"observe", stage:"observer", action:()=>({status:"HANDLED"})}
  ]});
  assert.equal((await alone.dispatch(event("普通文本"))).status, "NOT_MATCHED");
});

test("显式命令与未识别命令都不会触发 observer", async () => {
  const d = new GameHubDispatcher(); const calls = [];
  d.registerPlugin({id:"utility", name:"Utility", defaultNamespace:{prefix:"!"}, routes:[
    {id:"run", tokens:["run"], action:()=>{calls.push("command");}},
    {id:"observe", stage:"observer", action:()=>{calls.push("observer");}},
    {id:"fallback", stage:"fallback", action:()=>{calls.push("fallback");}}
  ]});
  assert.equal((await d.dispatch(event("!run"))).status, "HANDLED");
  assert.equal((await d.dispatch(event("!unknown"))).status, "HANDLED");
  assert.equal((await d.dispatch(event("#unknown"))).status, "HANDLED");
  assert.deepEqual(calls, ["command"]);
});

test("被 text 阶段消费的事件不会触发 observer", async () => {
  const d = new GameHubDispatcher(); const calls = [];
  d.registerPlugin({id:"consumer", name:"Consumer", defaultNamespace:{prefix:"!"}, routes:[
    {id:"text", stage:"text", match:e=>e.cleanText==="消费我", action:()=>{calls.push("text");}},
    {id:"observe", stage:"observer", action:()=>{calls.push("observer");}},
    {id:"fallback", stage:"fallback", action:()=>{calls.push("fallback");}}
  ]});
  assert.equal((await d.dispatch(event("消费我"))).status, "HANDLED");
  assert.deepEqual(calls, ["text"]);
  // 同一插件在 text 未命中时仍会依次进入 observer 与 fallback。
  assert.equal((await d.dispatch(event("普通文本"))).status, "HANDLED");
  assert.deepEqual(calls, ["text", "observer", "fallback"]);
});

test("observer 的 route.match 生效：不匹配时不调用", async () => {
  const d = new GameHubDispatcher(); const calls = [];
  d.registerPlugin({id:"gated", name:"Gated", defaultNamespace:{prefix:"!"}, routes:[
    {id:"observe", stage:"observer", match:e=>e.cleanText==="触发词", action:()=>{calls.push("observer");}},
    {id:"fallback", stage:"fallback", action:()=>{calls.push("fallback");}}
  ]});
  await d.dispatch(event("其它文本"));
  assert.deepEqual(calls, ["fallback"]);
  await d.dispatch(event("触发词"));
  assert.deepEqual(calls, ["fallback", "observer", "fallback"]);
});

test("shaper 从 at 段产出 mentions/mentionedBot，无 at 段时为空数组与 false", () => {
  const at = InboundShaper.shape({post_type:"message", user_id:9, group_id:1, self_id:12345, message:[{type:"at", data:{qq:"12345"}}, {type:"text", data:{text:" 你好"}}]});
  assert.deepEqual(at.mentions, [{id:"12345"}]);
  assert.equal(at.mentions[0].id, "12345");
  assert.equal(at.mentionedBot, true);
  assert.equal(at.cleanText, "你好");

  const other = InboundShaper.shape({post_type:"message", self_id:999, message:[{type:"at", data:{qq:"12345"}}, {type:"text", data:{text:"你好"}}]});
  assert.equal(other.mentionedBot, false);

  const all = InboundShaper.shape({post_type:"message", self_id:1, message:[{type:"at", data:{qq:"all"}}, {type:"text", data:{text:"通知"}}]});
  assert.deepEqual(all.mentions, [{id:"all"}]);
  assert.equal(all.mentionedBot, false);

  const plain = InboundShaper.shape({post_type:"message", self_id:1, message:[{type:"text", data:{text:"你好"}}]});
  assert.deepEqual(plain.mentions, []);
  assert.equal(plain.mentionedBot, false);
});
