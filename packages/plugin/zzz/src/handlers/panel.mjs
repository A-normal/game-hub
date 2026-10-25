import { command, problem } from "../text.mjs";
import { storeFor } from "../storage.mjs";
import { normalizeOfficialAvatar, normalizeEnkaAvatar, findAvatar, panelText, scoreAvatar, damageEstimate } from "../panel.mjs";
const inflight=new Set();
export async function handlePanel(ctx) {
  const store=storeFor(ctx),owner=ctx.event.unifiedUserId;
  const args=[...ctx.args]; const uidIndex=args.findIndex(v=>/^\d{8,10}$/.test(v));
  const publicUid=uidIndex<0 ? null : args.splice(uidIndex,1)[0];
  const formulaIndex=["damage","score","weights"].includes(ctx.routeId) && args.length>1 && /^\d{1,4}$/.test(args.at(-1)) ? Math.max(0,Number(args.pop())-1) : 0;
  const mainstatSlot=ctx.routeId==="mainstats" && args.length>1 && /^[456]$/.test(args.at(-1))?Number(args.pop()):4;
  const role=publicUid ? {uid:publicUid,region:"public"} : ctx.activeRole;
  if (!role) { await ctx.event.reply("请先使用「"+command(ctx,"loginQr")+"」，或使用「"+command(ctx,"panel",["<UID>","[角色名/ID]"])+"」查询公开展柜。"); return; }
  const source=publicUid || ctx.routeId==="showcase" || ctx.routeId==="showcaseRefresh" ? "enka" : "mihoyo";
  const cacheRole={...role,region:source==="enka"?"public":role.region};
  const key=owner+":"+role.uid+":"+source;
  const aliases={...(ctx.config.aliases || {}),...store.option(owner,"aliases",{})};
  const query=args.join(" ").trim();
  let cache=store.get(owner,cacheRole,"panel",source);
  const refresh=/Refresh|refresh/.test(ctx.routeId) || !cache;
  const now=ctx.services.now?.() ?? Date.now();
  if (refresh) {
    if (inflight.has(key)) throw problem("当前角色正在更新面板，请稍后查询。");
    const cooldown=Math.max(1000,Number(ctx.config.panelCooldownMs ?? 60000));
    if (cache && now-cache.updatedAt<cooldown) throw problem("更新冷却中，请稍后重试；可查询已缓存面板。");
    inflight.add(key);
    try {
      let avatars,ttl;
      if (source==="mihoyo") {
        const list=await ctx.client.record("avatars",role.uid,role.region);
        if (!Array.isArray(list.avatar_list)) throw problem("官方角色列表格式异常，旧缓存已保留。");
        const normalized=list.avatar_list.map(normalizeOfficialAvatar);
        const selected=query ? findAvatar(normalized,query,aliases) : null;
        if (query && !selected) throw problem("当前账号中没有该角色，旧缓存已保留。");
        const ids=selected ? [selected.id] : normalized.map(r=>r.id);
        const staged=[];
        for (let i=0;i<ids.length;i+=20) {
          const result=await ctx.client.record("avatar",role.uid,role.region,{id_list:ids.slice(i,i+20),need_wiki:true});
          if (!Array.isArray(result.avatar_list)) throw problem("官方面板格式异常，旧缓存已保留。");
          staged.push(...result.avatar_list.map(normalizeOfficialAvatar));
        }
        if (ids.some(id=>!staged.some(row=>row.id===id))) throw problem("官方返回的角色不完整，旧缓存已保留。");
        avatars=query ? [...(cache?.data.avatars || []).filter(row=>row.id!==selected.id),...staged] : staged;
      } else {
        const fetcher=ctx.services.fetchImpl || ((...params)=>fetch(...params));
        const response=await fetcher("https://enka.network/api/zzz/uid/"+role.uid,{headers:{"User-Agent":"Game-Hub/1.0"},redirect:"error",signal:AbortSignal.timeout(15000)});
        if (!response.ok) throw problem("公开展柜请求失败（HTTP "+response.status+"），旧缓存已保留。");
        const data=await response.json(); const raw=data.PlayerInfo?.ShowcaseDetail?.AvatarList;
        if (!Array.isArray(raw)) throw problem("公开展柜数据缺失，旧缓存已保留。");
        avatars=raw.filter(row=>!row.IsHidden).map(normalizeEnkaAvatar); ttl=Number(data.ttl)||60;
        const calculation=await import("../calculation.mjs");
        for(const avatar of avatars) {
          avatar.name=avatar.name===avatar.id ? calculation.characterKey(avatar.id) || avatar.id : avatar.name;
          try {const model=calculation.calculateAvatar(avatar);avatar.properties=model.initial;avatar.calculationVersion=model.version;}
          catch(error) {avatar.calculationNote=error.publicMessage || "公开面板规则尚未覆盖该数据。";}
        }
        if (query) { const selected=findAvatar(avatars,query,aliases); if (!selected) throw problem("公开展柜没有该角色，旧缓存已保留。"); avatars=[...(cache?.data.avatars || []).filter(row=>row.id!==selected.id),selected]; }
      }
      if (!avatars.length) throw problem("没有公开角色或账号尚无角色，旧缓存已保留。");
      store.put(owner,cacheRole,"panel",source,{avatars,source,ttl});
      cache=store.get(owner,cacheRole,"panel",source);
    } finally { inflight.delete(key); }
  }
  const avatars=cache.data.avatars;
  if(ctx.routeId==="proficiency" && !query) {
    const levels=avatars.map(row=>Number(row.level)).filter(Number.isFinite);
    const discs=avatars.flatMap(row=>row.equipment || []);
    await ctx.event.reply("【绝区零练度统计】来源："+source+"\n角色："+avatars.length+"；满级："+levels.filter(level=>level===60).length+"；已知等级平均："+(levels.length?(levels.reduce((a,b)=>a+b,0)/levels.length).toFixed(2):"未返回")+"\n装备驱动盘："+discs.length+"\n指定角色查看收益评分："+command(ctx,"score",["<角色名/ID>"]));return;
  }
  if (!query || ctx.routeId==="panelList") { await ctx.event.reply("【绝区零面板列表】来源："+source+"\n"+avatars.map(row=>row.name+" ["+row.id+"] Lv."+row.level).join("\n")+"\n"+command(ctx,"panel",["<角色名/ID>"])); return; }
  const selected=findAvatar(avatars,query,aliases); if (!selected) throw problem("缓存中没有该角色，请使用「"+command(ctx,"panelRefresh",[query])+"」。");
  const lines=panelText(selected);
  if(selected.calculationNote)lines.push(selected.calculationNote);
  const rule=ctx.config.scoring?.[selected.id]; const score=scoreAvatar(selected,rule);
  if (rule && ["proficiency","score","panel"].includes(ctx.routeId)) lines.push(score ? "属性达成评分: "+score.score.toFixed(2)+"/100（规则 "+score.version+"）" : "当前输入不满足该属性达成规则。");
  if (ctx.routeId==="damage" && !ctx.config.damageRules?.[selected.id] || ["score","weights","proficiency","conditions","mainstats"].includes(ctx.routeId) && !rule) {
    const {calculateAvatar,substatAnalysis,mainstatAnalysis,calculationConditions}=await import("../calculation.mjs");
    const scenario=store.option(owner,"calculationScenario",ctx.config.calculationScenario || {});
    const model=calculateAvatar(selected,scenario,avatars);
    if(!model.formulas.length)throw problem("缺少已知技能等级，没有可计算的角色专属招式。");
    const index=Math.min(formulaIndex,model.formulas.length-1),formula=model.formulas[index];
    lines.push("计算规则："+model.version,"场景：Lv."+model.scenario.enemyLevel+" / DEF "+model.scenario.enemyDefense+" / RES "+model.scenario.resistance+" / "+model.scenario.critMode+" / "+(model.scenario.stunned?"失衡":"未失衡"),"条件增益仅按已保存配置启用；默认关闭。");
    if(ctx.routeId==="conditions") {for(const item of calculationConditions(model.key))lines.push(item.id+"："+item.type+(item.type==="bool"?" 0/1":item.type==="num"?" "+item.min+"～"+item.max:JSON.stringify(item.list)));lines.push(command(ctx,"calculationSettings",['{"conditions":{...}}']));}
    else if(ctx.routeId==="mainstats") {for(const item of mainstatAnalysis(model,formula,mainstatSlot))lines.push(mainstatSlot+" 号位 "+item.stat+"："+item.damage.toFixed(0)+"（"+(item.gain>=0?"+":"")+item.gain.toFixed(2)+"%）");}
    else if(ctx.routeId==="damage") {
      const row=model.damage(formula);lines.push("招式 "+(index+1)+" / "+model.formulas.length+"："+row.name,"伤害期望："+row.value.toFixed(0),"该结果为当前场景的单次技能实例，不代表完整实战循环。",command(ctx,"damage",[query,String(Math.min(index+2,model.formulas.length))]));
    } else {
      const analysis=substatAnalysis(model,formula);lines.push("收益基准："+analysis.formula);
      if(ctx.routeId==="weights")for(const [stat,row] of Object.entries(analysis.weights))lines.push(stat+" 每词条 "+row.roll+" → "+row.gain.toFixed(3)+"%");
      else {lines.push("副词条收益评分："+(analysis.score===null?"没有驱动盘":analysis.score.toFixed(2)+" / 100"));for(const disc of analysis.discs)lines.push(disc.slot+" 号盘："+disc.score.toFixed(2)+" / 100；等效最优词条 "+disc.effectiveRolls.toFixed(2));}
    }
  }
  if (ctx.routeId==="weights" && rule) lines.push(JSON.stringify(rule));
  if (ctx.routeId==="damage" && ctx.config.damageRules?.[selected.id]) {
    const estimate=damageEstimate(selected,ctx.config.damageRules?.[selected.id],ctx.config.damageScenario);
    lines.push(...(estimate ? ["场景估算，规则 "+estimate.version,JSON.stringify(estimate.scenario),...estimate.hits.map(hit=>hit.name+": "+hit.value.toFixed(0)),"合计: "+estimate.total.toFixed(0)] : ["该角色或场景尚无完整的独立伤害规则，不输出虚构伤害。"]));
  }
  lines.push("缓存时间: "+new Date(cache.updatedAt).toISOString());
  await ctx.event.reply(lines.join("\n"));
}
