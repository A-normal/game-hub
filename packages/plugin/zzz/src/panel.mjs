import { problem, shown } from "./text.mjs";
const numberValue = value => { const n=Number(String(value??"").replace(/[% ,]/g,"")); return value!==undefined && value!==null && value!=="" && Number.isFinite(n) ? n : null; };
export function normalizeOfficialAvatar(raw) {
  const id=String(raw.id || raw.avatar_id || ""); if (!/^\d+$/.test(id)) throw problem("官方角色数据缺少 ID。");
  const properties={};
  for (const stat of raw.properties || raw.property_list || []) {
    if (stat.property_name || stat.name) properties[stat.property_name || stat.name]={value:stat.final ?? stat.value ?? stat.base, id:stat.property_id};
  }
  return {id,name:raw.full_name_mi18n || raw.full_name || raw.name_mi18n || raw.name || id,level:raw.level ?? null,rank:raw.rank ?? raw.talent_level ?? null,source:"mihoyo",properties,weapon:raw.weapon || null,equipment:raw.equip || raw.equipment || [],skills:raw.skills || [],profession:raw.avatar_profession,raw};
}
export function normalizeEnkaAvatar(raw) {
  if (!/^\d+$/.test(String(raw.Id))) throw problem("公开展柜角色缺少 ID。");
  return {id:String(raw.Id),name:raw.Name || String(raw.Id),level:raw.Level ?? null,rank:raw.TalentLevel ?? null,source:"enka",properties:{},weapon:raw.Weapon || null,equipment:raw.EquippedList || [],skills:raw.SkillLevelList || {},raw};
}
export function findAvatar(rows, input, aliases={}) {
  if (!input) return null;
  const normalized = text=>String(text).toLowerCase().replace(/[·\s]/g,"");
  const key=normalized(aliases[input] || input);
  const exact=rows.find(row=>row.id===key || normalized(row.name)===key); if (exact) return exact;
  const matches=rows.filter(row=>normalized(row.name).includes(key));
  if (matches.length>1) throw problem("角色名称不唯一，请使用完整名称或角色 ID。");
  return matches[0] || null;
}
export function scoreAvatar(avatar, rule) {
  if (!rule || !rule.version || !rule.weights || !rule.reference) return null;
  let total=0, max=0; const details=[];
  for (const [name,weight] of Object.entries(rule.weights)) {
    const value=numberValue(avatar.properties[name]?.value); const reference=Number(rule.reference[name]);
    if (value===null || !Number.isFinite(weight) || weight<0 || !Number.isFinite(reference) || reference<=0) return null;
    total+=Math.min(value/reference,1)*weight; max+=weight; details.push({name,value,reference,weight});
  }
  return max>0 ? {score:100*total/max,details,version:rule.version} : null;
}
export function damageEstimate(avatar, rule, scenario={}) {
  if (!rule || !rule.version || !Array.isArray(rule.hits)) return null;
  const stats=Object.fromEntries(Object.entries(avatar.properties).map(([k,v])=>[k,numberValue(v.value)]));
  const resist=Number(scenario.resistance ?? 0.1), defense=Number(scenario.defenseMultiplier ?? 0.5), bonus=Number(scenario.damageBonus ?? 0), vulnerability=Number(scenario.vulnerability ?? 0);
  if (![resist,defense,bonus,vulnerability].every(Number.isFinite) || defense<0 || defense>1 || resist<0 || resist>1 || bonus<0 || vulnerability<0) throw problem("伤害场景参数不在支持范围。");
  const results=[];
  for (const hit of rule.hits) {
    const base=stats[hit.stat]; const multiplier=Number(hit.multiplier); const flat=Number(hit.flat || 0);
    if (base===null || base===undefined || !Number.isFinite(multiplier) || multiplier<0 || !Number.isFinite(flat)) return null;
    let crit=1;
    if (hit.canCrit) {
      const rate=stats[hit.critRateStat || "暴击率"], damage=stats[hit.critDamageStat || "暴击伤害"];
      if (rate===null || rate===undefined || damage===null || damage===undefined) return null;
      crit+=Math.min(100,Math.max(0,rate))/100*Math.max(0,damage)/100;
    }
    const value=(base*multiplier+flat)*(1+bonus)*(1-resist)*defense*(1+vulnerability)*crit;
    results.push({name:hit.name,value});
  }
  return {version:rule.version,scenario:{resistance:resist,defenseMultiplier:defense,damageBonus:bonus,vulnerability},hits:results,total:results.reduce((n,r)=>n+r.value,0)};
}
export function panelText(avatar) {
  const lines=["【绝区零角色面板 · "+shown(avatar.name)+"】","来源："+avatar.source,"等级: "+shown(avatar.level)+" | 影画: "+shown(avatar.rank)];
  for (const [name,stat] of Object.entries(avatar.properties)) lines.push(shown(name)+": "+shown(stat.value));
  if (!Object.keys(avatar.properties).length) lines.push("该来源未返回最终属性；不以默认值替代。Enka 原始属性需要版本对应的角色及装备规则计算。");
  if (avatar.weapon) lines.push("音擎: "+shown(avatar.weapon.name || avatar.weapon.Name || avatar.weapon.Id || avatar.weapon.id)+" Lv."+shown(avatar.weapon.level ?? avatar.weapon.Level));
  for (const equip of avatar.equipment) {
    const item=equip.equipment || equip.Equipment || equip;
    lines.push("驱动盘 "+shown(equip.equipment_type ?? equip.Slot ?? equip.slot)+": "+shown(item.name || item.Id || item.id)+" Lv."+shown(item.level ?? item.Level));
  }
  return lines;
}
