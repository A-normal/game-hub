import { randomInt } from "node:crypto";
export const chinaDay = time => new Date(time+8*3600000).toISOString().slice(0,10);
export function recordDeadline(data) {
  const value=data?.end_time ?? data?.hadal_info_v2?.end_time ?? data?.hadal_mem_detail_v2?.end_time;
  if(typeof value==="number" || typeof value==="string" && /^\d+$/.test(value)) return Number(value)>1000000000000?Number(value):Number(value)*1000;
  if(typeof value==="string")return Date.parse(value);
  if(value && [value.year,value.month,value.day].every(Number.isInteger))return Date.parse(String(value.year)+"-"+String(value.month).padStart(2,"0")+"-"+String(value.day).padStart(2,"0")+"T"+String(value.hour ?? 0).padStart(2,"0")+":"+String(value.minute ?? 0).padStart(2,"0")+":"+String(value.second ?? 0).padStart(2,"0")+"+08:00");
  return NaN;
}
export function nextSignTime(now, minute) {
  const day=Date.parse(chinaDay(now)+"T00:00:00+08:00");
  let next=day+minute*60000; if (next<=now) next+=86400000;
  return next;
}
export class ZzzTasks {
  constructor({store,vault,dispatcher,now=()=>Date.now(),random=randomInt,setTimer=setTimeout,clearTimer=clearTimeout}) {
    Object.assign(this,{store,vault,dispatcher,now,random,setTimer,clearTimer}); this.running=false; this.pending=null; this.controller=new AbortController();
  }
  async start() { if (this.running) return; this.running=true; this.controller=new AbortController(); this._schedule(); }
  _schedule() { if (this.running) this.timer=this.setTimer(async()=>{ this.pending=this.tick(); try {await this.pending;} finally {this.pending=null;this._schedule();} },60000); }
  async stop() { this.running=false; this.clearTimer(this.timer); this.controller.abort(); await this.pending; }
  configure({owner,role,kind,target,enabled,settings={}}) {
    const id=JSON.stringify([owner,role.uid,role.region,kind]);
    const old=this.store.jobs(owner).find(row=>row.id===id);
    const merged={...old?.settings,...settings};
    if (kind==="sign") merged.minute ??= this.random(7*60,22*60+1);
    const nextRun=kind==="sign" ? nextSignTime(this.now(),merged.minute) : this.now()+60000;
    const job={id,owner,uid:role.uid,region:role.region,kind,target,settings:merged,enabled,nextRun}; this.store.setJob(job); return job;
  }
  async tick() {
    const now=this.now();
    for (const job of this.store.jobs().filter(row=>row.enabled && row.nextRun<=now)) {
      if (this.controller.signal.aborted) return;
      if (!this.dispatcher.isPluginEnabled("zzz")) return;
      const roles=this.vault.getUserRoles(job.owner,"zzz");
      const bound=roles.find(role=>role.uid===job.uid && role.region===job.region);
      if (!bound) { this.store.setJob({...job,enabled:false}); continue; }
      // Resolve credentials through this owner's binding, never through a public UID.
      const account=this.vault.getUserCredential(job.owner,bound.provider_id,bound.account_key);
      if (!account) continue;
      const client=this.dispatcher.providers.get("mihoyo").createClient(account.cookies,account.device);
      const period=job.kind==="sign" ? chinaDay(now) : chinaDay(now)+":"+Math.floor(now/(Number(job.settings.intervalMinutes || 60)*60000));
      const state=this.store.runState(job.id,period);
      if (["delivered","sending"].includes(state)) { this._advance(job,now); continue; }
      try {
        let message;
        if (job.kind==="sign") {
          this.store.markRun(job.id,period,"requesting");
          const info=await client.signInfo(job.uid,job.region);
          if (!info.is_sign) {
            const response=await client.sign(job.uid,job.region);
            if (response.gt_result?.risk_code || response.risk_code) { job.enabled=false; this.store.setJob(job); message="自动签到需要官方安全验证，已停用。"; }
            else { const confirmation=await client.signInfo(job.uid,job.region); if (!confirmation.is_sign) throw new Error("Sign result not confirmed"); }
          }
          message ??= "【绝区零自动签到】"+job.uid+"："+(info.is_sign?"今日已签到":"签到请求已完成")+"。\n"+this.dispatcher.formatCommand({pluginId:"zzz",routeId:"signStatus"});
        } else {
          if (job.kind==="energy") {
            const note=await client.getDailyNote(job.uid,job.region); const e=note.energy?.progress || note.energy;
            if (!e || Number(e.current)<Number(job.settings.threshold ?? e.max)) { this._advance(job,now); continue; }
            message="【绝区零电量提醒】"+job.uid+"："+e.current+" / "+e.max+"\n"+this.dispatcher.formatCommand({pluginId:"zzz",routeId:"note"});
          } else {
            const mode=job.settings.mode || "shiyu";
            const data=await client.record(mode,job.uid,job.region);
            const remaining=(recordDeadline(data)-now)/1000;
            if (!Number.isFinite(remaining) || remaining<0 || remaining>Number(job.settings.hours || 24)*3600) { this._advance(job,now); continue; }
            message="【绝区零挑战提醒】"+job.uid+"："+mode+" 距截止约 "+Math.ceil(remaining/3600)+" 小时。\n"+this.dispatcher.formatCommand({pluginId:"zzz",routeId:mode==="deadly"?"deadly":"abyss"});
          }
        }
        if (this.controller.signal.aborted) return;
        // Persist before delivery: an ambiguous transport failure is never blindly resent.
        this.store.markRun(job.id,period,"sending");
        await this.dispatcher.deliver(job.target,message);
        this.store.markRun(job.id,period,"delivered");
        this._advance(job,now);
      } catch (error) {
        const current=this.store.runState(job.id,period);
        if (current==="requesting" || error.code==="DELIVERY_UNAVAILABLE") {
          // A lost sign response may have succeeded. Check official status on the next tick.
          this.store.markRun(job.id,period,"retry");
        }
        this.store.setJob({...job,nextRun:now+15*60000});
      }
    }
  }
  _advance(job,now) { this.store.setJob({...job,nextRun:job.kind==="sign" ? nextSignTime(now,job.settings.minute) : now+Number(job.settings.intervalMinutes || 60)*60000}); }
}
