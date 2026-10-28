import {isSensitiveText,resolvePolicy,sessionDataOf} from "./session.mjs";

export const INTERJECTION_DEFAULTS=Object.freeze({enabled:false,probability:5,keywordProbability:40,followupProbability:60,windowMs:15000,cooldownMs:60000,maxPerHour:6,keywords:[]});
export const EVENT_TYPES=["poke","join","leave","recall"];
export const MERGED_OPTIONS=new Set(["interjection",...EVENT_TYPES.map(type=>"event:"+type)]);
export const INHERITED_OPTIONS=new Set([...MERGED_OPTIONS,"eventsEnabled","memoryEnabled","stickersEnabled","maxMessages","maxCharsPerMessage","maxContextChars","requestsPerDay"]);
const FOLLOW="跟随全局";
const labels={characterId:"人物",groupPolicy:"群聊策略",privatePolicy:"私聊策略",policy:"策略",maxMessages:"窗口",maxCharsPerMessage:"单条长度",maxContextChars:"上下文预算",requestsPerDay:"每日额度",memoryEnabled:"记忆",stickersEnabled:"表情"};
const rules={窗口:["maxMessages",4,200],单条长度:["maxCharsPerMessage",50,4000],上下文预算:["maxContextChars",2000,80000],每日额度:["requestsPerDay",1,10000]};
const interjectionFields={概率:["probability",0,100,1],关键词概率:["keywordProbability",0,100,1],续聊概率:["followupProbability",0,100,1],冷却:["cooldownMs",15,3600,1000],窗口:["windowMs",5,300,1000],每小时:["maxPerHour",1,60,1]};
const bad=message=>{throw Object.assign(new Error(message),{publicMessage:message});};

export function interjectionChange(args) {
  const [option,...rest]=args;
  if(option===FOLLOW && !rest.length)return {key:"interjection",inherit:true};
  if(["on","off"].includes(option) && !rest.length)return {key:"interjection",field:"enabled",value:option==="on"};
  const field=option==="关键词"?"keywords":interjectionFields[option]?.[0];
  if(field && rest.length===1 && rest[0]===FOLLOW)return {key:"interjection",field,inherit:true};
  if(option==="关键词") {
    const text=rest.join(" "),words=text==="清空"?[]:[...new Set(text.split(/[,，、\s]+/).filter(Boolean))];
    if(isSensitiveText(text) || words.length>20 || words.some(w=>Array.from(w).length>40) || (!words.length && text!=="清空"))bad("关键词最多20个、每词40字，不能包含凭据；可填写清空。");
    return {key:"interjection",field:"keywords",value:words};
  }
  const rule=Object.hasOwn(interjectionFields,option)?interjectionFields[option]:null,value=Number(rest[0]);
  if(!rule || rest.length!==1 || !Number.isInteger(value) || value<rule[1] || value>rule[2])bad("参数无效。概率/关键词概率/续聊概率：0–100；冷却：15–3600秒；窗口：5–300秒；每小时：1–60次。");
  return {key:"interjection",field:rule[0],value:value*rule[3]};
}

export function eventChanges(args) {
  const [type,mode,...words]=args;
  if(type===FOLLOW && !mode)return [...EVENT_TYPES.map(name=>({key:"event:"+name,inherit:true})),{key:"eventsEnabled",inherit:true}];
  if(["on","off"].includes(type) && !mode)return EVENT_TYPES.map(name=>({key:"event:"+name,field:"mode",value:type==="on"?"template":"off"}));
  if(!EVENT_TYPES.includes(type))bad("事件类型请选择 poke、join、leave 或 recall。");
  if(mode===FOLLOW && !words.length)return [{key:"event:"+type,inherit:true}];
  if(!["off","template","persona"].includes(mode))bad("事件模式请选择 off、template 或 persona。");
  const text=words.join(" ");if(text.length>500 || isSensitiveText(text))bad("模板最多500字，不能包含凭据或可执行消息段。");
  return [{key:"event:"+type,field:"mode",value:mode},...(text?[{key:"event:"+type,field:"template",value:text}]:[])];
}

function snapshot(services,id) {
  const {store,config}=services,s=store.getSession(id);
  const modelId=s.modelProfileId || (store.getSetting("defaultModel") ?? (services.health?.defaultProfileId || config.model.defaultProfileId));
  const model=store.getModel(modelId || "");
  return JSON.stringify({character:s.characterId,policy:resolvePolicy(s,config),config:store.runtimeConfig(id,config),
    budget:store.getOption(id,"maxContextChars",model?.maxContextChars ?? config.model.maxContextChars),
    events:EVENT_TYPES.map(type=>store.getOption(id,"event:"+type,{mode:store.getOption(id,"eventsEnabled",false)?"template":"off"})),
    interjection:{...INTERJECTION_DEFAULTS,...store.getOption(id,"interjection",{})},memory:store.getOption(id,"memoryEnabled",false),stickers:store.getOption(id,"stickersEnabled",false)});
}

export function changePreferences(ctx,scope,changes) {
  const {services}=ctx,{store}=services,data=sessionDataOf(ctx.event);
  if(scope!=="global")store.ensureSession(data);
  if(scope==="global" && changes.some(change=>change.inherit))bad("全局设置不能跟随自身；请填写明确值。");
  const ids=scope==="global"?store.db.prepare("SELECT session_id FROM chat_sessions").all().map(row=>row.session_id):[data.sessionId];
  const before=new Map(ids.map(id=>[id,snapshot(services,id)])),affected=[];
  const write=()=>{
    // Older bulk event settings used a shared local switch. Materialize it before
    // removing one event override, so that restoring inheritance really uses global defaults.
    const legacy=scope!=="global"?store.getLocalOption(data.sessionId,"eventsEnabled"):undefined;
    if(legacy!==undefined && changes.some(change=>change.key.startsWith("event:"))) {
      for(const type of EVENT_TYPES)if(store.getLocalOption(data.sessionId,"event:"+type)===undefined)store.setOption(data.sessionId,"event:"+type,{mode:legacy?"template":"off"});
      store.deleteOption(data.sessionId,"eventsEnabled");
    }
    for(const {key,value,field,inherit=false} of changes) {
      if(scope!=="global" && key==="characterId") {store.db.prepare("UPDATE chat_sessions SET character_id=? WHERE session_id=?").run(inherit?null:(value || ""),data.sessionId);continue;}
      if(scope!=="global" && key==="policy") {store.db.prepare("UPDATE chat_sessions SET policy=? WHERE session_id=?").run(inherit?null:value,data.sessionId);continue;}
      if(scope==="global") {
        const old=store.getSetting("default:"+key,{});
        store.setSetting("default:"+key,field?{...old,[field]:value}:value);
      } else if(inherit && !field)store.deleteOption(data.sessionId,key);
      else if(field) {
        const patch={...store.getLocalOption(data.sessionId,key,{})};
        if(inherit)delete patch[field];else patch[field]=value;
        if(Object.keys(patch).length)store.setOption(data.sessionId,key,patch);else store.deleteOption(data.sessionId,key);
      } else store.setOption(data.sessionId,key,value);
    }
    for(const id of ids)if(scope!=="global" || before.get(id)!==snapshot(services,id)){store.bumpEpoch(id);affected.push(id);}
  };
  if(store.vault._transaction)store.vault._transaction(write);else write();
  for(const id of affected)services.engine.cancel(id);
}

export function preferenceSource(store,id,key,field) {
  const row=store.db.prepare("SELECT character_id,policy FROM chat_sessions WHERE session_id=?").get(id);
  if(key==="characterId")return row?.character_id!=null?"本会话指定":"跟随全局";
  if(key==="policy")return row?.policy!=null?"本会话指定":"跟随全局";
  const local=store.getLocalOption(id,key,undefined);
  return local!==undefined && (!field || Object.hasOwn(local,field))?"本会话指定":"跟随全局";
}

export async function configurationSettings(ctx) {
  const {store,config}=ctx.services,data=sessionDataOf(ctx.event),[scopeWord,setting,...values]=ctx.args;
  const global=scopeWord==="全局";
  if(!global && ![undefined,"本群","本会话"].includes(scopeWord))return ctx.event.reply("请指定全局、本群或本会话，再填写人物、策略、事件、插话或窗口等设置。");
  if(scopeWord==="本群" && !ctx.event.isGroup)return ctx.event.reply("本群设置请在目标群操作；私聊可使用本会话。");
  store.ensureSession(data);
  if(setting) {
    let changes;
    try {
      if(setting==="插话")changes=[interjectionChange(values)];
      else if(setting==="事件")changes=eventChanges(values);
      else {
        const key=Object.entries(labels).find(([,label])=>label===setting)?.[0];
        if(!key)bad("可设置：人物、群聊策略、私聊策略、策略、窗口、单条长度、上下文预算、每日额度、记忆、表情、事件、插话。");
        if(global && key==="policy")bad("全局请分别设置群聊策略和私聊策略。");
        if(!global && ["groupPolicy","privatePolicy"].includes(key))bad("本会话请使用策略。");
        const value=values.join(" ");
        if(!value)bad("请填写设置值；本会话可用跟随全局移除覆盖。");
        const change={key};
        if(value===FOLLOW)change.inherit=true;
        else if(key==="characterId") {
          if(value==="无")change.value=null;
          else {if(!store.getCharacter(value))bad("未找到人物 ID，请查看人物列表。");change.value=value;}
        } else if(["policy","groupPolicy","privatePolicy"].includes(key)) {
          if(!["off","mention","all"].includes(value) || (value==="mention" && (key==="privatePolicy" || (key==="policy" && !ctx.event.isGroup))))bad("群聊策略为off/mention/all，私聊为off/all。");
          change.value=value;
        } else if(["memoryEnabled","stickersEnabled"].includes(key)) {
          if(!["on","off"].includes(value))bad("请选择on或off。");change.value=value==="on";
        } else {
          const rule=rules[setting],number=Number(value);
          if(!Number.isInteger(number) || number<rule[1] || number>rule[2])bad(`${setting}范围：${rule[1]}–${rule[2]}。`);
          change.value=number;
        }
        changes=[change];
      }
      changePreferences(ctx,global?"global":"local",changes);
    } catch(error){if(!error.publicMessage)throw error;return ctx.event.reply(error.publicMessage);}
  }
  const session=store.getSession(data.sessionId);
  const defaultId=store.getSetting("defaultModel") ?? (ctx.services.health?.defaultProfileId || config.model.defaultProfileId);
  const model=store.getModel((global?defaultId:session.modelProfileId || defaultId) || "");
  const show=(key,fallback)=>global?store.getSetting("default:"+key,fallback):store.getOption(data.sessionId,key,fallback);
  const source=(key,field)=>global?"全局默认":preferenceSource(store,data.sessionId,key,field);
  const cardId=global?store.getSetting("default:characterId",null):session.characterId;
  const interjection={...INTERJECTION_DEFAULTS,...show("interjection",{})};
  const lines=[global?"【全局AI设置】":"【本会话AI设置】",`人物：${store.getCharacter(cardId || "")?.name || "通用助手"}（${source("characterId")}）`,
    global?`群聊策略：${show("groupPolicy",config.policy.groupDefault)}；私聊策略：${show("privatePolicy",config.policy.privateDefault)}`:`策略：${resolvePolicy(session,config)}（${source("policy")}）`,
    `窗口：${show("maxMessages",config.retention.maxMessages)}条（${source("maxMessages")}）；单条长度：${show("maxCharsPerMessage",config.retention.maxCharsPerMessage)}字（${source("maxCharsPerMessage")}）`,
    `上下文预算：${show("maxContextChars",model?.maxContextChars ?? config.model.maxContextChars)}字符（${source("maxContextChars")}）；每日额度：${show("requestsPerDay",config.limits.requestsPerDay)}（${source("requestsPerDay")}）`,
    `记忆注入：${show("memoryEnabled",false)?"on":"off"}（${source("memoryEnabled")}）；表情：${show("stickersEnabled",false)?"on":"off"}（${source("stickersEnabled")}）`,
    `插话：${interjection.enabled?"on":"off"}（${source("interjection","enabled")}）；普通${interjection.probability}%（${source("interjection","probability")}）；关键词${interjection.keywordProbability}%（${source("interjection","keywordProbability")}）；续聊${interjection.followupProbability}%（${source("interjection","followupProbability")}）`,
    `插话窗口${interjection.windowMs/1000}秒（${source("interjection","windowMs")}）；冷却${interjection.cooldownMs/1000}秒（${source("interjection","cooldownMs")}）；每小时${interjection.maxPerHour}次（${source("interjection","maxPerHour")}）`];
  lines.push(`关键词：${interjection.keywords.join("、") || "未设置"}（${source("interjection","keywords")}）`);
  for(const type of EVENT_TYPES){const event=show("event:"+type,{mode:show("eventsEnabled",false)?"template":"off"});lines.push(`事件${type}：${event.mode}（${source("event:"+type,"mode")}）`);}
  lines.push(`模型：${model?.label || model?.id || "尚未选择"}${!global && session.modelProfileId?"（本会话指定）":"（全局默认）"}`,
    "设置保存在数据库中，修改立即生效，重启后保留；各会话的历史与记忆独立。",
    `修改：${ctx.commands.format({routeId:"settings",args:[global?"全局":"本会话","人物","<人物ID>"]})}`,
    `恢复继承：${ctx.commands.format({routeId:"settings",args:["本会话","人物",FOLLOW]})}`,
    `模型详情：${ctx.commands.format({routeId:"modelInfo"})}；添加服务：${ctx.commands.format({routeId:"connectionAdd"})}`);
  await ctx.event.reply(lines.join("\n"));
}
