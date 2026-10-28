import {dayKey, resolvePolicy, sessionDataOf} from "./session.mjs";
import {INTERJECTION_DEFAULTS,changePreferences,interjectionChange} from "./preferences.mjs";

export {INTERJECTION_DEFAULTS};
export const interjectionSettings = (store, id) => ({...INTERJECTION_DEFAULTS,...store.getOption(id,"interjection",{})});
const decision = (services,id,reason,details={}) => {
  services.store.setOption(id,"interjectionLast",{at:services.now(),reason,...details});
  services.log.debug(`插话 reason=${reason}`);
};

export function isReplyToBot(store, id, event) {
  const replyId=event.replyMessage?.id;
  if(!replyId)return false;
  return !!store.db.prepare("SELECT 1 FROM chat_messages m WHERE m.session_id=? AND m.branch_id=? AND m.role='assistant' AND (m.platform_message_id=? OR EXISTS (SELECT 1 FROM chat_message_sources s WHERE s.session_id=m.session_id AND s.seq=m.seq AND s.message_id=?)) LIMIT 1")
    .get(id,store.branchOf(id),String(replyId),String(replyId));
}

export function tryInterjection(ctx,session) {
  const {services,event}=ctx,{store,engine}=services,id=session.sessionId,config=store.runtimeConfig(id,services.config);
  const settings=interjectionSettings(store,id);
  if(!event.isGroup || !settings.enabled)return false;
  const skip=reason=>{decision(services,id,reason);return false;};
  if(engine.busy(id))return skip("busy");
  if((event.mentions || []).some(item=>String(item.id)!==String(event.botId)))return skip("addressed_elsewhere");
  if(event.replyMessage?.id && !isReplyToBot(store,id,event))return skip("reply_elsewhere");
  const now=services.now(),last=store.getOption(id,"interjectionLastSpoke",null);
  if(last!==null && now-last<settings.cooldownMs)return skip("cooldown");
  const turns=store.getOption(id,"interjectionTurns",[]).filter(at=>now-at<3600000);
  if(turns.length>=settings.maxPerHour)return skip("hour_limit");
  if((store.getUsage(id,dayKey(now))?.requests || 0)>=config.limits.requestsPerDay)return skip("quota");
  const previous=store.getOption(id,"interjectionWindow",null);
  if(previous!==null && now-previous<settings.windowMs)return skip("window");
  // One draw per message-driven window, including unsuccessful draws. No idle timer.
  store.setOption(id,"interjectionWindow",now);
  const character=session.characterId ? store.getCharacter(session.characterId)?.card : null;
  const extra=character?.extensions?.game_hub?.interjection?.keywords;
  const keywords=[...settings.keywords,character?.name,...(Array.isArray(extra)?extra:[])].filter(k=>typeof k==="string" && k.trim() && Array.from(k).length<=60).slice(0,60);
  const text=event.cleanText.toLowerCase();
  const matched=keywords.some(word=>text.includes(word.toLowerCase()));
  const history=store.recentMessages(id,config.retention.maxMessages);
  const assistant=history.filter(row=>row.role==="assistant").at(-1);
  const previousUser=assistant && history.find(row=>row.seq===assistant.replyTo);
  const followup=!!assistant && now-assistant.createdAt<120000 && previousUser?.senderId===event.unifiedUserId;
  const probability=Math.max(settings.probability,matched?settings.keywordProbability:0,followup?settings.followupProbability:0);
  const roll=services.random()*100;
  if(roll>=probability){decision(services,id,"sample_miss",{probability});return false;}
  const reason=matched?"keyword":followup?"followup":"ambient";
  decision(services,id,"considering",{opportunity:reason,probability});
  const accepted=engine.enqueue({sessionId:id,epoch:session.epoch,trigger:"interjection",text:event.cleanText,
    userName:event.sender?.name,isGroup:true,reply:event.reply,opportunity:reason});
  if(!accepted)decision(services,id,"queue_full");
  return accepted;
}

const labels={disabled:"未开启",considering:"已交给模型判断",sample_miss:"本轮概率未命中",busy:"正在处理其他回复",addressed_elsewhere:"消息在称呼其他人",reply_elsewhere:"正在回复其他人的消息",cooldown:"发言冷却",hour_limit:"本小时发言已达上限",quota:"今日模型额度已用完",window:"同一观察窗口不重复抽签",silence:"模型选择沉默",stale:"有新消息，旧插话已丢弃",sent:"已发送插话",sent_stale:"已交付；等待确认时有新消息，后续输出已停止",delivery_failed:"插话交付失败",error:"模型或处理失败"};

export async function interjectionStatus(ctx) {
  const data=sessionDataOf(ctx.event);
  if(!data)return;
  if(!ctx.event.isGroup)return ctx.event.reply("自然插话用于群聊，请在目标群查看。");
  const {store}=ctx.services,settings=interjectionSettings(store,data.sessionId),last=store.getOption(data.sessionId,"interjectionLast",null);
  const policy=resolvePolicy(store.getSession(data.sessionId) || data,ctx.services.config);
  await ctx.event.reply(["【本群自然插话】",`开关：${settings.enabled?"开启":"关闭"}（群聊 mention 策略下生效）`,
    `当前策略：${policy}${policy!=="mention"?"；启用概率插话请先用 "+ctx.commands.format({routeId:"policySet",args:["mention"]}):""}`,
    `普通机会：${settings.probability}%；关键词：${settings.keywordProbability}%；同一人续聊：${settings.followupProbability}%`,
    `观察窗口：${settings.windowMs/1000}秒；发言冷却：${settings.cooldownMs/1000}秒；每小时最多${settings.maxPerHour}次插话`,
    `本群关键词：${settings.keywords.join("、") || "未设置"}；另外读取当前人物名称和显式兴趣关键词`,
    `最近判断：${last?(labels[last.reason] || last.reason):"暂无"}。模型可选择沉默，判断调用也计入每日额度。`,
    `设置：${ctx.commands.format({routeId:"interjectionSet",args:["on"]})}`].join("\n"));
}

export async function interjectionSet(ctx) {
  if(!ctx.event.isGroup)return ctx.event.reply("自然插话用于群聊，请在目标群设置。");
  if(!ctx.args.length)return interjectionStatus(ctx);
  const data=sessionDataOf(ctx.event),{store}=ctx.services;
  try{changePreferences(ctx,"local",[interjectionChange(ctx.args)]);}catch(error){if(!error.publicMessage)throw error;return ctx.event.reply(error.publicMessage);}
  // Preserve the last window and speaking cooldown across setting changes.
  if(!interjectionSettings(store,data.sessionId).enabled)decision(ctx.services,data.sessionId,"disabled");
  await interjectionStatus(ctx);
}
