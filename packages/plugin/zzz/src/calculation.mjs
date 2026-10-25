import * as engine from "../vendor/optimizer/engine.mjs";
import {problem} from "./text.mjs";
export const CALCULATION_VERSION="optimizer-2ce06b88a442";
export const characterKey=id=>engine.characterIds[String(id)] || null;
const statById={111:"hp",121:"atk",122:"impact",131:"def",201:"crit_",211:"crit_dmg_",213:"laceration_dmg_",231:"pen_",232:"pen",305:"enerRegen",312:"anomProf",314:"anomMas",315:"physical_dmg_",316:"fire_dmg_",317:"ice_dmg_",318:"electric_dmg_",319:"ether_dmg_"};
const statByName={"生命值":"hp","生命值上限":"hp","攻击力":"atk","防御力":"def","冲击力":"impact","暴击率":"crit_","暴击伤害":"crit_dmg_","穿透率":"pen_","穿透值":"pen","异常精通":"anomProf","异常掌控":"anomMas","能量自动回复":"enerRegen","物理属性伤害加成":"physical_dmg_","火属性伤害加成":"fire_dmg_","冰属性伤害加成":"ice_dmg_","电属性伤害加成":"electric_dmg_","以太属性伤害加成":"ether_dmg_"};
const statLabels={hp:"生命值",atk:"攻击力",def:"防御力",impact:"冲击力",crit_:"暴击率",crit_dmg_:"暴击伤害",pen_:"穿透率",pen:"穿透值",enerRegen:"能量自动回复",anomProf:"异常精通",anomMas:"异常掌控",physical_dmg_:"物理属性伤害加成",fire_dmg_:"火属性伤害加成",ice_dmg_:"冰属性伤害加成",electric_dmg_:"电属性伤害加成",ether_dmg_:"以太属性伤害加成"};
const skillTypes={0:"basic",1:"special",2:"dodge",3:"chain",6:"assist"};
export function propertyStat(id,name) {
  const number=Number(id),family=number>=10000?Math.floor(number/100):number;
  let key=statById[family] || statByName[name];
  if(key && number>=10000 && number%100===2 && !key.endsWith("_"))key+="_";
  return key || null;
}
function valueOf(value,key,raw=false) {
  const number=Number(String(value).replace(/[%,\s]/g,""));
  if(value===null || value===undefined || value==="" || !Number.isFinite(number))throw problem("属性包含无效数值。");
  return raw ? number/(key.endsWith("_")?10000:key==="enerRegen"?100:1) : number/(key.endsWith("_")?100:1);
}
function integer(value,min,max,label) {
  if(!Number.isInteger(Number(value)) || value===null || value===undefined || Number(value)<min || Number(value)>max)throw problem("缺少有效的"+label+"，不使用默认满级数据计算。");
  return Number(value);
}
function promotion(level,explicit) {
  if(explicit!==undefined)return integer(explicit,0,5,"突破等级");
  if(level===60)return 5;
  if(level%10===0)throw problem("等级边界需要明确突破等级，无法安全推断。");
  return Math.floor((level-1)/10);
}
function characterInput(avatar) {
  const key=characterKey(avatar.id);if(!key)throw problem("当前版本的独立计算库尚未收录该角色。");
  const raw=avatar.raw,enka=avatar.source==="enka";
  const level=integer(avatar.level,1,60,"角色等级"),mindscape=integer(avatar.rank,0,6,"影画等级");
  const core=enka?raw.CoreSkillEnhancement:raw.core_skill_enhancement ?? raw.core_skill_level ?? raw.skills?.find(row=>row.skill_type===5)?.level;
  const info={key,level,promotion:promotion(level,enka?raw.PromotionLevel:raw.promote_level ?? raw.promotion_level),mindscape,core:integer(core,0,6,"核心强化等级"),potential:Number(raw.PotentialLevel || raw.potential_level || 0)};
  const known=new Set();
  const skills=enka?(Array.isArray(raw.SkillLevelList)?raw.SkillLevelList:Object.entries(raw.SkillLevelList || {}).map(([Index,Level])=>({Index:Number(Index),Level}))):raw.skills || [];
  for(const kind of Object.values(skillTypes))info[kind]=1;
  for(const skill of skills) {
    const kind=skillTypes[enka?skill.Index:skill.skill_type];if(!kind)continue;
    let value=integer(enka?skill.Level:skill.level,1,16,"技能等级");
    if(!enka)value-=mindscape>=5?4:mindscape>=3?2:0;
    info[kind]=integer(value,1,12,"基础技能等级");known.add(kind);
  }
  return {info,known};
}
function equipmentInput(avatar) {
  const enka=avatar.source==="enka",stats={},sets={},discs=[];const seen=new Set();
  for(const equipped of avatar.equipment || []) {
    const item=enka?equipped.Equipment:equipped;
    if(!item)throw problem("驱动盘数据缺失。");
    const slot=integer(enka?equipped.Slot:item.equipment_type ?? item.slot,1,6,"驱动盘位置");
    if(seen.has(slot))throw problem("驱动盘位置重复。");seen.add(slot);
    const id=String(enka?item.Id:item.id),setId=enka?String(Math.floor(Number(id)/100)*100):String(item.equip_suit?.suit_id || Math.floor(Number(id)/100)*100);
    const set=engine.discIds[setId];if(!set)throw problem("当前计算库未收录该驱动盘套装。");
    sets[set]=(sets[set] || 0)+1;
    const rarity=enka?({4:"S",3:"A",2:"B"}[Number(id.at(-2))]):item.rarity;
    if(!["S","A","B"].includes(rarity))throw problem("驱动盘稀有度无效。");
    const level=integer(enka?item.Level:item.level,0,{S:15,A:12,B:9}[rarity],"驱动盘等级");
    const substats=[],main=[];
    for(const row of enka?item.MainStatList || []:item.main_properties || []) {
      const key=propertyStat(enka?row.PropertyId:row.property_id,row.property_name);
      if(!key)throw problem("存在未收录的驱动盘主属性。");
      const value=enka?engine.getDiscMainStatVal(rarity,key,level):valueOf(row.base,key);
      if(!Number.isFinite(value))throw problem("驱动盘主属性无法计算。");stats[key]=(stats[key] || 0)+value;main.push({key,value});
    }
    for(const row of enka?item.RandomPropertyList || []:item.properties || []) {
      const key=propertyStat(enka?row.PropertyId:row.property_id,row.property_name);
      if(!key)throw problem("存在未收录的驱动盘副属性。");
      const value=enka?valueOf(row.PropertyValue,key,true)*integer(row.PropertyLevel,1,6,"副属性词条次数"):valueOf(row.base,key);
      stats[key]=(stats[key] || 0)+value;substats.push({key,value,rolls:value/engine.getDiscSubStatBaseVal(key,rarity)});
    }
    discs.push({slot,rarity,level,set,substats,main});
  }
  let weapon;
  if(avatar.weapon) {
    const raw=avatar.weapon,id=String(enka?raw.Id:raw.id),key=engine.weaponIds[id];
    if(!key)throw problem("当前计算库未收录该音擎。");
    const level=integer(enka?raw.Level:raw.level,1,60,"音擎等级");
    weapon={key,level,modification:promotion(level,enka?raw.BreakLevel:raw.break_level ?? raw.promote_level),phase:integer(enka?raw.UpgradeLevel:raw.star,1,5,"音擎叠影等级")};
  }
  return {stats,sets,weapon,discs};
}
export const DEFAULT_SCENARIO=Object.freeze({enemyLevel:60,enemyDefense:794,resistance:0,stunned:false,stunMultiplier:1.5,critMode:"avg",conditions:{},team:[]});
export function validateScenario(input={}) {
  const allowed=new Set(Object.keys(DEFAULT_SCENARIO));for(const key of Object.keys(input))if(!allowed.has(key))throw problem("未知计算场景字段："+key);
  const value={...DEFAULT_SCENARIO,...input};
  if(!Array.isArray(value.team) || value.team.length>2 || new Set(value.team).size!==value.team.length || value.team.some(id=>typeof id!=="string" || !/^\d+$/.test(id)))throw problem("队友必须是最多两个不同的角色 ID 字符串。");
  integer(value.enemyLevel,1,100,"敌人等级");
  if(!Number.isFinite(value.enemyDefense) || value.enemyDefense<0 || value.enemyDefense>100000 || !Number.isFinite(value.resistance) || value.resistance< -1 || value.resistance>1 || !Number.isFinite(value.stunMultiplier) || value.stunMultiplier<1 || value.stunMultiplier>10 || typeof value.stunned!=="boolean" || !["avg","crit","nonCrit"].includes(value.critMode))throw problem("计算场景参数超出支持范围。");
  if(!value.conditions || Array.isArray(value.conditions) || typeof value.conditions!=="object" || Object.keys(value.conditions).length>100)throw problem("计算条件格式无效。");
  for(const [key,val] of Object.entries(value.conditions)) {
    if(!/^(?:[A-Za-z0-9_]+\/)?[A-Za-z0-9_]+:[A-Za-z0-9_]+$/.test(key) || typeof val!=="number" || !Number.isFinite(val))throw problem("计算条件必须为 [角色/]sheet:条件名 的有限数值。");
    const [qualified,name]=key.split(":"),sheet=qualified.split("/").at(-1),definition=engine.getConditional(sheet,name);
    if(sheet==="enemy")throw problem("敌人状态请使用场景中的 stunned 等字段设置。");
    if(!definition)throw problem("未定义的计算条件："+key);
    if(definition.type==="bool" && ![0,1].includes(val) || definition.type==="num" && (definition.int_only&&!Number.isInteger(val) || definition.min!==undefined&&val<definition.min || definition.max!==undefined&&val>definition.max) || definition.type==="list" && (!Number.isInteger(val) || val<0 || val>definition.list.length))throw problem("计算条件超出声明范围："+key);
  }
  return value;
}
export function calculateAvatar(avatar,input={},available=[]) {
  const {info,known}=characterInput(avatar),equipment=equipmentInput(avatar),scenario=validateScenario(input),key=info.key;
  const members=[{avatar,info,equipment},...scenario.team.map(id=>{
    if(id===avatar.id)throw problem("当前角色不能重复作为队友。");
    const teammate=available.find(row=>row.id===id);if(!teammate)throw problem("队友面板未缓存，请先更新该角色。");
    return {avatar:teammate,info:characterInput(teammate).info,equipment:equipmentInput(teammate)};
  })];
  const entries=[...members.flatMap(member=>engine.withMember(member.info.key,...engine.charTagMapNodeEntries(member.info),...engine.wengineTagMapNodeEntries(member.equipment.weapon),...engine.discTagMapNodeEntries(member.equipment.stats,member.equipment.sets))),...engine.teamData(members.map(member=>member.info.key)),engine.enemy.common.lvl.add(scenario.enemyLevel),engine.enemy.common.def.add(scenario.enemyDefense),engine.enemy.common.res_.add(scenario.resistance),engine.enemy.common.stun_.add(scenario.stunMultiplier),engine.enemy.common.unstun_.add(1),engine.own.common.critMode.with("src",key).add(scenario.critMode),engine.reader.withTag({qt:"cond",q:"isStunned",sheet:"enemy"}).add(Number(scenario.stunned))];
  for(const [name,value] of Object.entries(scenario.conditions)) {
    const [qualified,q]=name.split(":"),[first,second]=qualified.split("/"),sheet=second || first;
    const owners=members.filter(member=>(!second || member.info.key===first) && [member.info.key,member.equipment.weapon?.key,...Object.keys(member.equipment.sets)].includes(sheet));
    if(owners.length!==1 && sheet!=="anomaly")throw problem("计算条件不属于唯一的队员或装备，请用 角色/sheet:条件名 指定："+name);
    entries.push(engine.reader.withTag({src:owners[0]?.info.key || key,dst:null,sheet,qt:"cond",q}).add(value));
  }
  let effectiveEntries=entries;
  let calc=engine.zzzCalculatorWithEntries(entries);
  // Calibrate the initial panel to the official final attributes. Combat effects remain separate.
  const adjustments=[];
  for(const member of members.filter(member=>member.avatar.source==="mihoyo")) {
    for(const [name,property] of Object.entries(member.avatar.properties)) {
      const stat=propertyStat(property.id,name);if(!stat)continue;
      const current=calc.compute(engine.getStatFromStatKey(engine.own.initial,stat).with("src",member.info.key)).val;
      const target=valueOf(property.value,stat);if(!Number.isFinite(current))throw problem("初始面板基准计算失败。");
      if(Math.abs(target-current)>1e-10)adjustments.push(engine.getStatFromStatKey(engine.userBuff.initial,stat).with("src",member.info.key).add(target-current));
    }
  }
  effectiveEntries=[...entries,...adjustments];calc=engine.zzzCalculatorWithEntries(effectiveEntries);
  const initial={},combat={};
  for(const [stat,label] of Object.entries(statLabels)) {
    const first=calc.compute(engine.getStatFromStatKey(engine.own.initial,stat).with("src",key)).val;
    const final=calc.compute(engine.getStatFromStatKey(engine.own.final,stat).with("src",key)).val;
    if(!Number.isFinite(first) || !Number.isFinite(final))throw problem("角色属性计算得到无效结果。");
    initial[label]={value:stat.endsWith("_")?(first*100).toFixed(2)+"%":first.toFixed(2)};
    combat[label]={value:stat.endsWith("_")?(final*100).toFixed(2)+"%":final.toFixed(2)};
  }
  const formulas=Object.values(engine.formulaCatalog[key] || {}).filter(entry=>entry.skill&&known.has(entry.skill)&&Object.keys(entry.dims).some(dim=>["standardDmg","sheerDmg","sharpDmg","anomalyDmg"].includes(dim)));
  function damage(entry,extra=[]) {
    const dim=["standardDmg","sheerDmg","sharpDmg","anomalyDmg"].find(dim=>entry.dims[dim]);
    const read=engine.reader.withTag({...entry.dims[dim],src:key,dst:null,preset:"preset0"});
    const calculator=extra.length?engine.zzzCalculatorWithEntries([...effectiveEntries,...extra]):calc;
    const value=calculator.compute(read).val;if(!Number.isFinite(value) || value<0)throw problem("该招式在当前条件下无法计算。");
    return {name:entry.name,skill:entry.skill,dim,value};
  }
  return {version:CALCULATION_VERSION,key,info,equipment,scenario,initial,combat,formulas,damage,calc,entries:effectiveEntries};
}
export function substatAnalysis(calculation,formula) {
  const base=calculation.damage(formula).value;
  if(base<=0)throw problem("当前招式没有正伤害基准，无法进行收益评分。");
  const keys=["hp","atk","def","hp_","atk_","def_","crit_","crit_dmg_","anomProf","pen"];
  const weights={};
  for(const stat of keys) {
    const roll=engine.getDiscSubStatBaseVal(stat,"S");
    const entry=engine.getStatFromStatKey(engine.userBuff.initial,stat).with("src",calculation.key).add(roll);
    const after=calculation.damage(formula,[entry]).value;
    weights[stat]={roll,gain:Math.max(0,(after/base-1)*100)};
  }
  const best=Math.max(...Object.values(weights).map(row=>row.gain));
  const discs=calculation.equipment.discs.map(disc=>{
    const weighted=disc.substats.reduce((sum,row)=>sum+row.rolls*(weights[row.key]?.gain || 0),0);
    return {slot:disc.slot,level:disc.level,rarity:disc.rarity,effectiveRolls:best>0?weighted/best:0,score:best>0?Math.min(100,100*weighted/(9*best)):0};
  });
  return {version:CALCULATION_VERSION,formula:formula.name,base,weights,discs,score:discs.length?discs.reduce((sum,disc)=>sum+disc.score,0)/discs.length:null};
}
export function mainstatAnalysis(calculation,formula,slot=4) {
  const options={4:["hp_","atk_","def_","crit_","crit_dmg_","anomProf"],5:["hp_","atk_","def_","pen_","physical_dmg_","fire_dmg_","ice_dmg_","electric_dmg_","ether_dmg_"],6:["hp_","atk_","def_","anomMas_","impact_","enerRegen_"]}[slot];
  if(!options)throw problem("主词条比较仅支持 4、5、6 号位。");
  const current=calculation.equipment.discs.find(disc=>disc.slot===slot);if(!current)throw problem("该位置没有驱动盘，无法比较替换收益。");
  const base=calculation.damage(formula).value;if(base<=0)throw problem("当前条件下没有正伤害基准。");
  const removed=current.main.map(row=>engine.getStatFromStatKey(engine.userBuff.initial,row.key).with("src",calculation.key).add(-row.value));
  return options.map(stat=>{
    const value=engine.getDiscMainStatVal(current.rarity,stat,current.level);
    const add=engine.getStatFromStatKey(engine.userBuff.initial,stat).with("src",calculation.key).add(value);
    const damage=calculation.damage(formula,[...removed,add]).value;
    return {stat,value,damage,gain:(damage/base-1)*100};
  }).sort((a,b)=>b.damage-a.damage);
}
export function calculationConditions(key) {return Object.values(engine.conditionals[key] || {}).map(row=>({...row,id:key+":"+row.name}));}
export function calculationCoverage() {return engine.allCharacterKeys.map(key=>({key,id:engine.allStats.char[key].id,formulas:Object.values(engine.formulaCatalog[key] || {}).filter(row=>row.skill&&Object.keys(row.dims).some(dim=>["standardDmg","sheerDmg","sharpDmg","anomalyDmg"].includes(dim))).length}));}
export {engine};
