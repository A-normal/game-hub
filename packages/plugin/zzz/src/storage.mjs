export class ZzzStore {
  constructor(vault, now = () => Date.now()) {
    this.vault = vault; this.db = vault.db; this.now = now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS zzz_cache (owner TEXT, uid TEXT, region TEXT, kind TEXT, item_key TEXT, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(owner,uid,region,kind,item_key));
      CREATE TABLE IF NOT EXISTS zzz_gacha (owner TEXT, uid TEXT, region TEXT, record_id TEXT, pool TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner,uid,region,record_id));
      CREATE TABLE IF NOT EXISTS zzz_options (owner TEXT, option_key TEXT, payload TEXT NOT NULL, PRIMARY KEY(owner,option_key));
      CREATE TABLE IF NOT EXISTS zzz_jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, uid TEXT NOT NULL, region TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, settings TEXT NOT NULL, enabled INTEGER NOT NULL, next_run INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS zzz_job_runs (job_id TEXT, period TEXT, state TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(job_id,period));
      CREATE TABLE IF NOT EXISTS zzz_rankings (group_key TEXT, owner TEXT, uid TEXT, region TEXT, category TEXT, score REAL NOT NULL, nickname TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(group_key,owner,uid,region,category));
    `);
  }
  scope(owner, role) { return [owner, String(role.uid), role.region || "prod_gf_cn"]; }
  get(owner, role, kind, key = "default") {
    const row = this.db.prepare("SELECT payload,updated_at FROM zzz_cache WHERE owner=? AND uid=? AND region=? AND kind=? AND item_key=?").get(...this.scope(owner, role), kind, String(key));
    return row ? { data: JSON.parse(row.payload), updatedAt: row.updated_at } : null;
  }
  put(owner, role, kind, key, value) {
    this.db.prepare("INSERT INTO zzz_cache VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,uid,region,kind,item_key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at").run(...this.scope(owner, role), kind, String(key), JSON.stringify(value), this.now());
  }
  list(owner, role, kind) { return this.db.prepare("SELECT item_key,payload,updated_at FROM zzz_cache WHERE owner=? AND uid=? AND region=? AND kind=? ORDER BY item_key").all(...this.scope(owner, role), kind).map(row => ({ key: row.item_key, data: JSON.parse(row.payload), updatedAt: row.updated_at })); }
  option(owner, key, defaultValue = null) {
    const row = this.db.prepare("SELECT payload FROM zzz_options WHERE owner=? AND option_key=?").get(owner, key);
    return row ? JSON.parse(row.payload) : defaultValue;
  }
  setOption(owner, key, data) { this.db.prepare("INSERT INTO zzz_options VALUES(?,?,?) ON CONFLICT(owner,option_key) DO UPDATE SET payload=excluded.payload").run(owner, key, JSON.stringify(data)); }
  importGacha(owner, role, records) {
    return this.vault._transaction(() => {
      let added = 0;
      const stmt = this.db.prepare("INSERT OR IGNORE INTO zzz_gacha VALUES(?,?,?,?,?,?)");
      for (const record of records) {
        const old=this.db.prepare("SELECT payload FROM zzz_gacha WHERE owner=? AND uid=? AND region=? AND record_id=?").get(...this.scope(owner,role),record.id);
        if(old) { const previous=JSON.parse(old.payload); if(previous.gacha_type!==record.gacha_type || previous.time!==record.time || previous.rank_type!==record.rank_type) throw Object.assign(new Error("Conflicting gacha ID"),{publicMessage:"调频记录与已保存的相同 ID 冲突，整批写入已回滚。"}); }
        added += Number(stmt.run(...this.scope(owner, role), record.id, record.gacha_type, JSON.stringify(record)).changes);
      }
      return added;
    });
  }
  gacha(owner, role) { return this.db.prepare("SELECT payload FROM zzz_gacha WHERE owner=? AND uid=? AND region=?").all(...this.scope(owner, role)).map(row => JSON.parse(row.payload)).sort((a,b) => a.time.localeCompare(b.time) || (BigInt(a.id) < BigInt(b.id) ? -1 : 1)); }
  setJob(job) { this.db.prepare("INSERT INTO zzz_jobs VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET target=excluded.target,settings=excluded.settings,enabled=excluded.enabled,next_run=excluded.next_run").run(job.id,job.owner,job.uid,job.region,job.kind,JSON.stringify(job.target),JSON.stringify(job.settings),Number(job.enabled),job.nextRun); }
  jobs(owner) { return this.db.prepare("SELECT * FROM zzz_jobs" + (owner ? " WHERE owner=?" : "")).all(...(owner ? [owner] : [])).map(row => ({ ...row, enabled: Boolean(row.enabled), target: JSON.parse(row.target), settings: JSON.parse(row.settings), nextRun: row.next_run })); }
  runState(id, period) { return this.db.prepare("SELECT state FROM zzz_job_runs WHERE job_id=? AND period=?").get(id,period)?.state; }
  markRun(id, period, state) { this.db.prepare("INSERT INTO zzz_job_runs VALUES(?,?,?,?) ON CONFLICT(job_id,period) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at").run(id,period,state,this.now()); }
  publish(group, owner, role, category, score) { if (!Number.isFinite(score)) throw new TypeError("Invalid ranking score"); this.db.prepare("INSERT INTO zzz_rankings VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(group_key,owner,uid,region,category) DO UPDATE SET score=excluded.score,nickname=excluded.nickname,updated_at=excluded.updated_at").run(group,owner,role.uid,role.region,category,score,role.nickname,this.now()); }
  rankings(group, category) { return this.db.prepare("SELECT owner,uid,nickname,score FROM zzz_rankings WHERE group_key=? AND category=? ORDER BY score DESC LIMIT 50").all(group,category).filter(row => !this.option(row.owner,"rankHidden",false)); }
  clearRanking(group, owner) { return this.db.prepare("DELETE FROM zzz_rankings WHERE group_key=?" + (owner ? " AND owner=?" : "")).run(group,...(owner ? [owner] : [])); }
}
const stores = new WeakMap();
export function storeFor(ctx) {
  if (ctx.services?.store) return ctx.services.store;
  if (!ctx.vault) throw new Error("ZZZ requires persistent storage");
  if (!stores.has(ctx.vault)) stores.set(ctx.vault, new ZzzStore(ctx.vault));
  return stores.get(ctx.vault);
}
