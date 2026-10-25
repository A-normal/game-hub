import test from "node:test";
import assert from "node:assert/strict";
import {normalizeOfficialAvatar,normalizeEnkaAvatar} from "../packages/plugin/zzz/src/panel.mjs";
import {calculateAvatar,calculationCoverage,substatAnalysis,mainstatAnalysis,validateScenario,engine} from "../packages/plugin/zzz/src/calculation.mjs";
import {verifyVendor} from "../tools/verify-vendor.mjs";
const make=(id=1191,rank=0)=>normalizeOfficialAvatar({id,full_name_mi18n:"测试角色",level:60,rank,properties:[{property_id:121,property_name:"攻击力",final:"2000"},{property_id:201,property_name:"暴击率",final:"50%"},{property_id:211,property_name:"暴击伤害",final:"100%"}],skills:[0,1,2,3,6].map(skill_type=>({skill_type,level:12+(rank>=5?4:rank>=3?2:0)})).concat([{skill_type:5,level:6}]),equip:[]});
test("MIT source and standalone bundle retain matching hashes and original license",async()=>{
  const result=await verifyVendor();assert.equal(result.pin,"2ce06b88a442531b49d84cbed15204a4a03d078a");assert.equal(result.files,1224);
});
test("all catalog characters evaluate their specific skill damage without generic placeholders",()=>{
  const coverage=calculationCoverage();assert.equal(coverage.length,60);let count=0;
  for(const row of coverage) {
    assert.ok(row.formulas>0,row.key);const model=calculateAvatar(make(row.id));
    assert.equal(model.key,row.key);assert.ok(model.formulas.length>0,row.key);
    for(const formula of model.formulas) {const result=model.damage(formula);assert.ok(Number.isFinite(result.value),row.key+":"+formula.name);assert.ok(result.value>=0);assert.ok(!/^(standard|sheer)DmgInst$/.test(result.name));count++;}
  }
  assert.equal(count,1292);
});
test("specific Ellen baseline matches independent skill/crit/defense vector; stun has its own zone",()=>{
  const model=calculateAvatar(make());const hit=model.formulas.find(row=>row.name==="BasicAttackSawTeethTrimming_0");
  // Lv12: (0.488 + 11*0.045) * 2000 ATK * (1 + 0.5*1) * (794/(794+794)).
  assert.ok(Math.abs(model.damage(hit).value-1474.5)<1e-8);assert.equal(model.initial.攻击力.value,"2000.00");
  const stunned=calculateAvatar(make(),{stunned:true});assert.ok(Math.abs(stunned.damage(hit).value/model.damage(hit).value-1.5)<1e-10);
  const zeroDef=calculateAvatar(make(),{enemyDefense:0});assert.ok(Math.abs(zeroDef.damage(hit).value/model.damage(hit).value-2)<1e-10);
});
test("team eligibility and bounded character conditions alter ice damage only when valid",()=>{
  const main=make(),teammate=make(engine.allStats.char.Lycaon.id);
  const off=calculateAvatar(main,{team:[teammate.id]},[teammate]);
  const on=calculateAvatar(main,{team:[teammate.id],conditions:{"Ellen:ice_attacks":10}},[teammate]);
  const ice=off.formulas.find(row=>row.name==="BasicAttackFlashFreezeTrimming_0");
  assert.ok(Math.abs(on.damage(ice).value/off.damage(ice).value-1.3)<1e-10);
  assert.throws(()=>validateScenario({conditions:{"Ellen:ice_attacks":11}}),/声明范围/);
  assert.throws(()=>validateScenario({conditions:{"Ellen:unknown":1}}),/未定义/);
  assert.throws(()=>calculateAvatar(main,{team:["999999"]},[]),/未缓存/);
});
test("Enka raw attributes, skill levels, weapon and discs produce a real initial panel",()=>{
  const raw={Id:1191,Level:60,TalentLevel:0,PromotionLevel:5,CoreSkillEnhancement:6,SkillLevelList:[{Index:0,Level:12}],Weapon:{Id:14119,Level:60,BreakLevel:5,UpgradeLevel:1},EquippedList:[{Slot:4,Equipment:{Id:31044,Level:15,MainStatList:[{PropertyId:20101,PropertyValue:600}],RandomPropertyList:[{PropertyId:21103,PropertyValue:480,PropertyLevel:3}]}}]};
  assert.equal(engine.weaponIds["14119"],"DeepSeaVisitor");
  const model=calculateAvatar(normalizeEnkaAvatar(raw));assert.equal(model.equipment.weapon.key,"DeepSeaVisitor");assert.equal(model.equipment.discs[0].set,"WoodpeckerElectro");
  assert.ok(Number(model.initial.攻击力.value)>1600);assert.equal(model.initial.暴击率.value,"67.40%");assert.equal(model.initial.暴击伤害.value,"64.40%");
  const score=substatAnalysis(model,model.formulas[0]);assert.ok(score.weights.crit_.gain>=0);assert.equal(score.discs[0].slot,4);
  const mains=mainstatAnalysis(model,model.formulas[0],4);assert.equal(mains.length,6);assert.ok(mains.every(row=>Number.isFinite(row.damage)));
});
test("missing raw model data refuses calculations instead of manufacturing full levels",()=>{
  const a=make();delete a.raw.skills;assert.throws(()=>calculateAvatar(a),/核心强化/);
  assert.throws(()=>calculateAvatar({...make(),level:50}),/突破等级/);
  assert.throws(()=>calculateAvatar({...make(),id:"999999"}),/尚未收录/);
});
