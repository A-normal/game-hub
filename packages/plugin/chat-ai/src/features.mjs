import crypto from "node:crypto";
import {hasChatAdmin} from "./admin.mjs";
import {clipText,isSensitiveText,sessionDataOf,resolvePolicy} from "./session.mjs";

const current = ctx => {const data=sessionDataOf(ctx.event);ctx.services.store.ensureSession(data);return data;};
const usage = (ctx,id,args=[]) => ctx.commands.format({routeId:id,args});
export async function memorySet(ctx) {
  const d=current(ctx), value=ctx.args[0];if(!["on","off"].includes(value))return ctx.event.reply("请选择 on 或 off。");
  ctx.services.store.setOption(d.sessionId,"memoryEnabled",value==="on");ctx.services.store.bumpEpoch(d.sessionId);ctx.services.engine.cancel(d.sessionId);
  await ctx.event.reply(value==="on"?"本会话显式长期记忆已启用；仅注入你主动登记的内容。":"本会话长期记忆注入已关闭，已保存记录仍可查看或删除。");
}
export async function memoryAdd(ctx) {
  const d=current(ctx), text=String(ctx.argumentText || "").trim();if(!text || text.length>500 || isSensitiveText(text))return ctx.event.reply("请输入不含凭据、最多500字符的明确记忆。");
  if(ctx.services.store.listMemories(d.sessionId).length>=40)return ctx.event.reply("本会话最多保存40条记忆，请先删除不需要的记录。");
  const id=ctx.services.store.addMemory(d.sessionId,text);await ctx.event.reply(`已保存本会话记忆 #${id}。默认不注入模型；启用：${usage(ctx,'memorySet',['on'])}`);
}
export async function memoryList(ctx) {
  const d=current(ctx), rows=ctx.services.store.listMemories(d.sessionId);
  await ctx.event.reply(["【本会话显式记忆】",...rows.map(r=>`#${r.id} ${r.text}`),rows.length?"仅此会话可见，不跨群或私聊共享。":"暂无记忆。"].join("\n"));
}
export async function memoryDelete(ctx) {
  const d=current(ctx),removed=ctx.services.store.deleteMemory(d.sessionId,ctx.args[0]);
  if(removed) {ctx.services.store.bumpEpoch(d.sessionId);ctx.services.engine.cancel(d.sessionId);}
  await ctx.event.reply(removed?"已删除该条记忆，旧请求已失效。":"该记忆不存在于当前会话。");
}
export async function summarize(ctx) {
  const d=current(ctx), session=ctx.services.store.getSession(d.sessionId);
  if(!ctx.services.store.countMessages(d.sessionId))return ctx.event.reply("当前人物分支还没有可以总结的对话。");
  if(!ctx.services.engine.enqueue({sessionId:d.sessionId,epoch:session.epoch,text:"总结对话",reply:ctx.event.reply,isGroup:ctx.event.isGroup,trigger:"explicit",mode:"summary"}))await ctx.event.reply("队列已满。");
}
export async function summaryClear(ctx) {const d=current(ctx);ctx.services.store.setOption(d.sessionId,"summary:"+ctx.services.store.branchOf(d.sessionId),"");ctx.services.store.setOption(d.sessionId,"summarySources:"+ctx.services.store.branchOf(d.sessionId),[]);ctx.services.store.bumpEpoch(d.sessionId);ctx.services.engine.cancel(d.sessionId);await ctx.event.reply("本人物分支摘要已删除，旧请求已失效。");}
const eventTypes={poke:"戳一戳",join:"入群",leave:"离群",recall:"撤回"};
const eventTemplates={join:"欢迎新朋友加入，坐下聊聊吧。",leave:"一位群友离开了，愿之后的路一切顺利。",poke:"嗯？我在，想聊些什么？",recall:"收到撤回提醒，相关上下文已更新。"};
export async function eventSet(ctx) {
  const d=current(ctx),[type,mode,...words]=ctx.args,{store}=ctx.services;
  if(["on","off"].includes(type)) {
    store.setOption(d.sessionId,"eventsEnabled",type==="on");
    if(type==="off")for(const name of Object.keys(eventTypes))store.setOption(d.sessionId,"event:"+name,{mode:"off"});
    else for(const name of Object.keys(eventTypes))store.setOption(d.sessionId,"event:"+name,{mode:"template"});
    store.bumpEpoch(d.sessionId);ctx.services.engine.cancel(d.sessionId);
    return ctx.event.reply(`本会话事件响应已${type==='on'?'开启（固定模板）':'关闭'}。可单独设置：poke|join|leave|recall + off|template|persona + 可选模板。`);
  }
  if(!eventTypes[type] || !["off","template","persona"].includes(mode))return ctx.event.reply("用法：事件设置 on|off，或 事件设置 <poke|join|leave|recall> <off|template|persona> [模板文字]。");
  const template=words.join(" ");
  if(template.length>500 || isSensitiveText(template))return ctx.event.reply("模板最多500字，不能包含凭据或可执行消息段。");
  store.setOption(d.sessionId,"event:"+type,{mode,template:template || eventTemplates[type]});
  store.bumpEpoch(d.sessionId);ctx.services.engine.cancel(d.sessionId);
  await ctx.event.reply(`${eventTypes[type]}响应：${mode}。同类事件同一发起者冷却30秒，会话事件总冷却10秒；人物模式会调用模型并计入额度，也可以选择不回复。`);
}
export async function eventResponse(ctx) {
  const e=ctx.event,d=sessionDataOf(e),{store}=ctx.services;
  if(!d)return false;
  const recall=["group_recall","friend_recall"].includes(e.noticeType);
  const type=recall?"recall":e.noticeType==="group_increase"?"join":e.noticeType==="group_decrease"?"leave":e.noticeType==="notify" && e.noticeSubtype==="poke" && e.targetUserId===e.botId?"poke":null;
  if(!type)return false;
  if(!store.claimEvent(d.sessionId,e.eventId))return true;
  if(recall) {
    const affected=store.recallMessage(d.sessionId,e.recalledMessageId);
    ctx.services.engine.cancelAffected?.(d.sessionId,affected);
  }
  if(ctx.dispatcher?.isPluginEnabled?.("chat-ai")===false || resolvePolicy(store.getSession(d.sessionId),ctx.services.config)==="off")return true;
  const settings=store.getOption(d.sessionId,"event:"+type,{mode:store.getOption(d.sessionId,"eventsEnabled",false)?"template":"off"});
  if(settings.mode==="off")return true;
  const now=ctx.services.now(),key="noticeCooldown:"+type+":"+e.sender?.id,last=store.getOption(d.sessionId,key,null),global=store.getOption(d.sessionId,"lastNotice",null);
  if((last!==null && now-last<30000) || (global!==null && now-global<10000))return true;
  // Reserve cooldown before an asynchronous reply or enqueue, preventing burst duplicates.
  store.setOption(d.sessionId,key,now);store.setOption(d.sessionId,"lastNotice",now);
  if(settings.mode==="persona") {
    const session=store.ensureSession(d);
    return ctx.services.engine.enqueue({sessionId:d.sessionId,epoch:session.epoch,trigger:"event",notice:{type,actor:clipText(e.sender?.name || e.sender?.id,40),target:e.targetUserId || null},userName:e.sender?.name,isGroup:e.isGroup,reply:e.reply}) || true;
  }
  await e.reply(settings.template || eventTemplates[type]);return true;
}
export {stickerAdd,stickerList,stickerDelete} from "./assets.mjs";
export async function stickerSet(ctx) {const d=current(ctx),value=ctx.args[0];if(!["on","off"].includes(value))return ctx.event.reply("请选择 on 或 off。");ctx.services.store.setOption(d.sessionId,"stickersEnabled",value==="on");ctx.services.store.bumpEpoch(d.sessionId);await ctx.event.reply(`本会话表情回复已${value==='on'?'开启':'关闭'}，只能使用管理员登记的素材。`);}
export async function proactiveSet(ctx) {
  const d=current(ctx), minutes=Number(ctx.args[0]),{store,scheduler}=ctx.services;
  if(!Number.isInteger(minutes) || (minutes!==0 && (minutes<5 || minutes>1440)))return ctx.event.reply("请输入5至1440分钟；0表示关闭。");
  const id="idle-"+crypto.createHash("sha256").update(d.sessionId).digest("hex").slice(0,20);
  if(minutes===0) {store.db.prepare("DELETE FROM chat_jobs WHERE id=? AND session_id=?").run(id,d.sessionId);store.bumpEpoch(d.sessionId);ctx.services.engine.cancel(d.sessionId);scheduler?.refresh();return ctx.event.reply("本会话主动发言已关闭。");}
  const target={platform:ctx.event.platform,botId:ctx.event.botId,isGroup:!!ctx.event.isGroup,groupId:ctx.event.groupId,userId:ctx.event.sender.id,owner:ctx.event.unifiedUserId,ownerRaw:ctx.event.sender.id};
  const now=ctx.services.now();
  store.db.prepare("INSERT INTO chat_jobs(id,session_id,target,interval_ms,next_run,enabled) VALUES(?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET target=excluded.target,interval_ms=excluded.interval_ms,next_run=excluded.next_run,enabled=1").run(id,d.sessionId,JSON.stringify(target),minutes*60000,now+minutes*60000);
  scheduler?.refresh();
  await ctx.event.reply(`本会话空闲${minutes}分钟后可主动问候；23:00–08:00安静，重启后保留。每次尝试只执行一次，不补发离线期间的积压。关闭：${usage(ctx,'proactiveSet',['0'])}`);
}
export async function proactiveStatus(ctx) {const d=current(ctx),row=ctx.services.store.db.prepare("SELECT interval_ms,next_run FROM chat_jobs WHERE session_id=? AND enabled=1").get(d.sessionId);await ctx.event.reply(row?`本会话主动发言间隔：${row.interval_ms/60000}分钟；下次检查：${new Date(row.next_run).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`:"本会话主动发言未开启。");}

export function createScheduler(services) {
  let running=false,timer=null,busy=false;
  const stop=()=>{running=false;if(timer)clearInterval(timer);timer=null;};
  const refresh=()=>{if(timer && !services.store.db.prepare("SELECT id FROM chat_jobs WHERE enabled=1 LIMIT 1").get()) {clearInterval(timer);timer=null;} if(running && !timer && services.store.db.prepare("SELECT id FROM chat_jobs WHERE enabled=1 LIMIT 1").get()) {timer=setInterval(()=>void tick().catch(()=>services.log.warn("主动任务检查失败")),30000);timer.unref?.();}};
  async function tick() {
    if(!running || busy || services.dispatcher?.isPluginEnabled?.("chat-ai")===false)return;
    busy=true;
    try {
      const now=services.now();
      const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(now));
      for(const job of services.store.db.prepare("SELECT * FROM chat_jobs WHERE enabled=1 AND next_run<=? LIMIT 20").all(now)) {
        const session=services.store.getSession(job.session_id);
        // 在任何外部副作用前推进计划，避免重启或并发 tick 重放本轮。
        const claimed=services.store.db.prepare("UPDATE chat_jobs SET next_run=?,last_run=? WHERE id=? AND next_run=?").run(now+job.interval_ms,now,job.id,job.next_run).changes;
        if(!claimed || !session || session.policy==='off' || hour>=23 || hour<8 || now-session.updatedAt<job.interval_ms)continue;
        const target=JSON.parse(job.target);
        if(!target.owner || !hasChatAdmin({unifiedUserId:target.owner,sender:{id:target.ownerRaw}},{vault:services.store.vault,dispatcher:services.dispatcher})) {
          services.store.db.prepare("UPDATE chat_jobs SET enabled=0 WHERE id=?").run(job.id);
          services.log.warn("主动任务创建者权限失效，已停用任务");continue;
        }
        services.engine.enqueue({sessionId:job.session_id,epoch:session.epoch,text:"主动问候",trigger:"scheduled",reply:content=>services.dispatcher.deliver(target,content),isGroup:session.scope==='group'});
      }
    } finally {busy=false;}
  }
  return {start(){running=true;refresh();},stop,refresh,tick};
}
