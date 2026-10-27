/**
 * @file packages/plugin/chat-ai/src/store.mjs
 * @description chat-ai 自有表（chat_ 前缀）的建表与 SQL 存取。
 *              只做 SQL 与行映射，不做业务判断；所有语句均为参数化 prepared statement。
 */

import crypto from "node:crypto";

const DDL = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  session_id       TEXT PRIMARY KEY,
  platform         TEXT NOT NULL,
  bot_id           TEXT,
  scope            TEXT NOT NULL CHECK (scope IN ('private', 'group')),
  scope_id         TEXT NOT NULL,
  character_id     TEXT,
  model_profile_id TEXT,
  policy           TEXT CHECK (policy IS NULL OR policy IN ('off', 'mention', 'all')),
  epoch            INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  event_id    TEXT,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  sender_id   TEXT,
  sender_name TEXT,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (session_id, event_id)
);

CREATE TABLE IF NOT EXISTS chat_characters (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  card       TEXT NOT NULL,
  owner      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_models (
  id                TEXT PRIMARY KEY,
  label             TEXT,
  endpoint          TEXT NOT NULL,
  model             TEXT NOT NULL,
  api_key_env       TEXT NOT NULL,
  temperature       REAL,
  max_output_tokens INTEGER,
  timeout_ms        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_usage (
  session_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  requests   INTEGER NOT NULL DEFAULT 0,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, day)
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, seq);
CREATE TABLE IF NOT EXISTS chat_connections (id TEXT PRIMARY KEY, label TEXT NOT NULL, endpoint TEXT NOT NULL, api_key_env TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chat_settings (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_receipts (session_id TEXT NOT NULL, event_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session_id,event_id));
CREATE TABLE IF NOT EXISTS chat_options (session_id TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,key));
CREATE TABLE IF NOT EXISTS chat_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chat_stickers (id TEXT PRIMARY KEY, label TEXT NOT NULL, file TEXT NOT NULL, tags TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_jobs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, target TEXT NOT NULL, interval_ms INTEGER NOT NULL, next_run INTEGER NOT NULL, last_run INTEGER, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS chat_recalls (session_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session_id,message_id));
CREATE TABLE IF NOT EXISTS chat_message_sources (session_id TEXT NOT NULL,message_id TEXT NOT NULL,seq INTEGER NOT NULL,branch_id TEXT NOT NULL,PRIMARY KEY(session_id,message_id,seq));
CREATE TABLE IF NOT EXISTS chat_asset_meta (id TEXT PRIMARY KEY,hash TEXT,status TEXT NOT NULL,character_id TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS chat_dependencies (session_id TEXT NOT NULL,assistant_seq INTEGER NOT NULL,source_seq INTEGER NOT NULL,branch_id TEXT NOT NULL,PRIMARY KEY(session_id,assistant_seq,source_seq));
CREATE INDEX IF NOT EXISTS idx_chat_dependencies_source ON chat_dependencies(session_id,source_seq);
`;

const nullable = value => (value === undefined ? null : value);
const boundedInt = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.trunc(Number(value)) : fallback);

const mapSession = row => ({
  sessionId: row.session_id,
  platform: row.platform,
  botId: row.bot_id ?? null,
  scope: row.scope,
  scopeId: row.scope_id,
  characterId: row.character_id ?? null,
  modelProfileId: row.model_profile_id ?? null,
  policy: row.policy ?? null,
  epoch: Number(row.epoch ?? 0),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at)
});

const mapMessage = row => ({
  seq: Number(row.seq),
  messageId: row.platform_message_id ?? null,
  replyTo: row.reply_to_seq == null ? null : Number(row.reply_to_seq),
  role: row.role,
  senderId: row.sender_id ?? null,
  senderName: row.sender_name ?? null,
  text: row.text,
  createdAt: Number(row.created_at)
});

const mapModel = row => ({
  id: row.id,
  label: row.label ?? null,
  connectionId: row.connection_id ?? null,
  endpoint: row.endpoint,
  model: row.model,
  apiKeyEnv: row.api_key_env,
  temperature: row.temperature === null || row.temperature === undefined ? null : Number(row.temperature),
  maxOutputTokens: row.max_output_tokens === null || row.max_output_tokens === undefined ? null : Number(row.max_output_tokens),
  timeoutMs: row.timeout_ms === null || row.timeout_ms === undefined ? null : Number(row.timeout_ms),
  maxContextChars:row.max_context_chars == null ? null : Number(row.max_context_chars),
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at)
});

export class ChatStore {
  /**
   * @param {{db:Object, _transaction?:Function}} vault 已打开的 IdentityVault
   * @param {{now?:()=>number}} [options]
   */
  constructor(vault, {now = Date.now} = {}) {
    if (!vault?.db) throw new Error("chat-ai 需要 vault 才能建立会话表");
    this.vault = vault;
    this.db = vault.db;
    this.now = now;
    // 可重入建表：插件重复装配或重启都不会丢数据。
    this.db.exec(DDL);
    const migrate = () => {
      for (const [table, column, definition] of [["chat_models", "connection_id", "TEXT"], ["chat_models","max_context_chars","INTEGER"], ["chat_messages", "branch_id", "TEXT NOT NULL DEFAULT ''"], ["chat_messages", "reply_to_seq", "INTEGER"], ["chat_messages","platform_message_id","TEXT"]]) {
        if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
      for (const row of this.db.prepare("SELECT * FROM chat_models WHERE connection_id IS NULL").all()) {
        const id = this.connectionIdFor(row.endpoint, row.api_key_env);
        if (!this.getConnection(id)) this.saveConnection({id, label: row.label || row.id, endpoint: row.endpoint, apiKeyEnv: row.api_key_env});
        this.db.prepare("UPDATE chat_models SET connection_id=? WHERE id=?").run(id, row.id);
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_chat_messages_reply ON chat_messages(session_id,reply_to_seq)");
    };
    if (typeof vault._transaction === "function") vault._transaction(migrate); else migrate();
  }

  /** 确保会话行存在（保留已有策略/人物/模型绑定与 epoch）。 */
  ensureSession({sessionId, platform, botId = null, scope, scopeId}) {
    const now = this.now();
    this.db.prepare(
      "INSERT INTO chat_sessions (session_id, platform, bot_id, scope, scope_id, epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?) " +
      "ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at"
    ).run(String(sessionId), String(platform), nullable(botId), String(scope), String(scopeId), now, now);
    return this.getSession(sessionId);
  }

  getSession(sessionId) {
    const row = this.db.prepare("SELECT * FROM chat_sessions WHERE session_id = ?").get(String(sessionId));
    return row ? mapSession(row) : null;
  }

  /** 策略变更同时递增 epoch（旧回复任务据此失效）。 */
  setPolicy(sessionId, policy) {
    return this.db.prepare("UPDATE chat_sessions SET policy = ?, epoch = epoch + 1, updated_at = ? WHERE session_id = ?")
      .run(nullable(policy), this.now(), String(sessionId)).changes > 0;
  }

  /** 人物切换/卸下同时递增 epoch。 */
  setCharacter(sessionId, characterId) {
    return this.db.prepare("UPDATE chat_sessions SET character_id = ?, epoch = epoch + 1, updated_at = ? WHERE session_id = ?")
      .run(nullable(characterId), this.now(), String(sessionId)).changes > 0;
  }

  /** 模型档案变更同时递增 epoch。 */
  setModelProfile(sessionId, modelProfileId) {
    return this.db.prepare("UPDATE chat_sessions SET model_profile_id = ?, epoch = epoch + 1, updated_at = ? WHERE session_id = ?")
      .run(nullable(modelProfileId), this.now(), String(sessionId)).changes > 0;
  }

  bumpEpoch(sessionId) {
    return this.db.prepare("UPDATE chat_sessions SET epoch = epoch + 1, updated_at = ? WHERE session_id = ?")
      .run(this.now(), String(sessionId)).changes > 0;
  }

  /**
   * 写入一条消息；返回是否真的新增（同一会话重复 event_id 时被 UNIQUE 忽略）。
   * assistant 行的 event_id 传 null：SQLite 的 NULL 不参与 UNIQUE 冲突。
   */
  insertMessage({sessionId, eventId = null, role, senderId = null, senderName = null, text, createdAt = null, replyTo = null, messageId = null,sourceSeqs=[]}) {
    const insert=()=>{
      if(messageId && this.db.prepare("SELECT 1 FROM chat_recalls WHERE session_id=? AND message_id=?").get(String(sessionId),String(messageId)))return false;
      const result = this.db.prepare(
        "INSERT OR IGNORE INTO chat_messages (session_id, event_id, role, sender_id, sender_name, text, created_at, branch_id, reply_to_seq,platform_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(String(sessionId), nullable(eventId), String(role), nullable(senderId), nullable(senderName), String(text ?? ""), createdAt ?? this.now(), this.branchOf(sessionId), replyTo,nullable(messageId));
      if(result.changes && messageId)this.db.prepare("INSERT OR IGNORE INTO chat_message_sources VALUES(?,?,?,?)").run(String(sessionId),String(messageId),Number(result.lastInsertRowid),this.branchOf(sessionId));
      if(result.changes && role==="assistant")for(const seq of new Set(sourceSeqs))this.db.prepare("INSERT OR IGNORE INTO chat_dependencies VALUES(?,?,?,?)").run(sessionId,Number(result.lastInsertRowid),seq,this.branchOf(sessionId));
      return Number(result.changes) > 0;
    };
    return typeof this.vault._transaction==="function"?this.vault._transaction(insert):insert();
  }

  /** 最近 limit 条，按 seq 升序返回（便于直接拼 prompt）。 */
  recentMessages(sessionId, limit = 20) {
    const size = boundedInt(limit, 20);
    const rows = this.db.prepare(
      "SELECT seq, role, sender_id, sender_name, text, created_at, reply_to_seq,platform_message_id FROM chat_messages WHERE session_id = ? AND branch_id = ? ORDER BY seq DESC LIMIT ?"
    ).all(String(sessionId), this.branchOf(sessionId), size);
    return rows.reverse().map(mapMessage);
  }

  recallMessage(sessionId,messageId) {
    if(!messageId)return {seqs:[],summaries:[]};
    const recall=()=>{
      this.db.prepare("INSERT OR IGNORE INTO chat_recalls VALUES(?,?,?)").run(sessionId,String(messageId),this.now());
      // Source index survives history pruning so a summary can still be invalidated.
      const sources=this.db.prepare("SELECT seq,branch_id FROM chat_message_sources WHERE session_id=? AND message_id=? UNION SELECT seq,branch_id FROM chat_messages WHERE session_id=? AND platform_message_id=?").all(sessionId,String(messageId),sessionId,String(messageId));
      const seqs=new Set(sources.map(r=>Number(r.seq))),branches=new Set(sources.map(r=>r.branch_id));
      const pending=[...seqs];
      const dependents=this.db.prepare("SELECT assistant_seq AS seq,branch_id FROM chat_dependencies WHERE session_id=? AND source_seq=? UNION SELECT seq,branch_id FROM chat_messages WHERE session_id=? AND reply_to_seq=?");
      for(let index=0;index<pending.length;index++)for(const row of dependents.all(sessionId,pending[index],sessionId,pending[index])) {
        const seq=Number(row.seq);if(seqs.has(seq))continue;
        seqs.add(seq);pending.push(seq);branches.add(row.branch_id);
      }
      for(const seq of seqs)this.db.prepare("DELETE FROM chat_messages WHERE session_id=? AND seq=?").run(sessionId,seq);
      const summaries=[];
      for(const branch of branches) {
        const key="summary:"+branch,summary=this.getOption(sessionId,key,"");
        if(!summary)continue;
        const refs=this.getOption(sessionId,"summarySources:"+branch,null);
        if(!Array.isArray(refs) || refs.some(seq=>seqs.has(seq))) {
          this.setOption(sessionId,key,"");this.setOption(sessionId,"summarySources:"+branch,[]);summaries.push(key);
        }
      }
      return {seqs:[...seqs],summaries};
    };
    return typeof this.vault._transaction==="function"?this.vault._transaction(recall):recall();
  }

  countMessages(sessionId) {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM chat_messages WHERE session_id = ? AND branch_id = ?").get(String(sessionId), this.branchOf(sessionId));
    return Number(row?.total ?? 0);
  }

  deleteMessages(sessionId) {
    return Number(this.db.prepare("DELETE FROM chat_messages WHERE session_id = ? AND branch_id = ?").run(String(sessionId), this.branchOf(sessionId)).changes);
  }

  /** 只保留最新 maxMessages 条；返回删除条数。 */
  pruneMessages(sessionId, maxMessages) {
    const keep = Number.isFinite(Number(maxMessages)) && Number(maxMessages) >= 0 ? Math.trunc(Number(maxMessages)) : 20;
    return Number(this.db.prepare(
      "DELETE FROM chat_messages WHERE session_id = ? AND branch_id = ? AND seq NOT IN (SELECT seq FROM chat_messages WHERE session_id = ? AND branch_id = ? ORDER BY seq DESC LIMIT ?)"
    ).run(String(sessionId), this.branchOf(sessionId), String(sessionId), this.branchOf(sessionId), keep).changes);
  }

  saveCharacter({id, name, card, owner = null}) {
    const now = this.now();
    const payload = typeof card === "string" ? card : JSON.stringify(card ?? {});
    this.db.prepare(
      "INSERT INTO chat_characters (id, name, card, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET name = excluded.name, card = excluded.card, owner = excluded.owner, updated_at = excluded.updated_at"
    ).run(String(id), String(name ?? ""), payload, nullable(owner), now, now);
    return this.getCharacter(id);
  }

  getCharacter(id) {
    const row = this.db.prepare("SELECT * FROM chat_characters WHERE id = ?").get(String(id));
    if (!row) return null;
    let card = null;
    try { card = JSON.parse(row.card); } catch { card = null; }
    return {id: row.id, name: row.name, card, owner: row.owner ?? null, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)};
  }

  listCharacters() {
    return this.db.prepare("SELECT id, name, owner, updated_at FROM chat_characters ORDER BY name COLLATE NOCASE, id").all()
      .map(row => ({id: row.id, name: row.name, owner: row.owner ?? null, updatedAt: Number(row.updated_at)}));
  }

  deleteCharacter(id) {
    return Number(this.db.prepare("DELETE FROM chat_characters WHERE id = ?").run(String(id)).changes) > 0;
  }

  saveModel({id, label = null, endpoint, model, apiKeyEnv, connectionId = null, temperature = null, maxOutputTokens = null, timeoutMs = null,maxContextChars}) {
    const now = this.now();
    const existing = this.getModel(id);
    connectionId ||= this.connectionIdFor(endpoint, apiKeyEnv);
    if (!this.getConnection(connectionId)) this.saveConnection({id: connectionId, label: label || id, endpoint, apiKeyEnv});
    if (existing && connectionId === existing.connectionId && ((endpoint && endpoint !== existing.endpoint) || (apiKeyEnv && apiKeyEnv !== existing.apiKeyEnv))) {
      const current=this.getConnection(connectionId);
      this.saveConnection({...current,endpoint:endpoint || current.endpoint,apiKeyEnv:apiKeyEnv || current.apiKeyEnv});
    }
    const resolved = this.getConnection(connectionId);
    endpoint = resolved.endpoint; apiKeyEnv = resolved.apiKeyEnv;
    this.db.prepare(
      "INSERT INTO chat_models (id, label, endpoint, model, api_key_env, temperature, max_output_tokens, timeout_ms, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET label = excluded.label, endpoint = excluded.endpoint, model = excluded.model, api_key_env = excluded.api_key_env, " +
      "temperature = excluded.temperature, max_output_tokens = excluded.max_output_tokens, timeout_ms = excluded.timeout_ms, updated_at = excluded.updated_at"
    ).run(String(id), nullable(label), String(endpoint), String(model), String(apiKeyEnv), nullable(temperature), nullable(maxOutputTokens), nullable(timeoutMs), now, now);
    this.db.prepare("UPDATE chat_models SET connection_id=? WHERE id=?").run(connectionId, String(id));
    this.db.prepare("UPDATE chat_models SET max_context_chars=? WHERE id=?").run(maxContextChars ?? existing?.maxContextChars ?? null,String(id));
    if (existing) this.invalidateModel(id);
    return this.getModel(id);
  }

  getModel(id) {
    const row = this.db.prepare("SELECT m.*, COALESCE(c.endpoint,m.endpoint) AS endpoint, COALESCE(c.api_key_env,m.api_key_env) AS api_key_env FROM chat_models m LEFT JOIN chat_connections c ON c.id=m.connection_id WHERE m.id = ?").get(String(id));
    return row ? mapModel(row) : null;
  }

  /** 按创建顺序返回（默认模型取"第一个配置好的可用档案"依赖这个顺序）。 */
  listModels() {
    return this.db.prepare("SELECT id FROM chat_models ORDER BY created_at ASC, id ASC").all().map(row => this.getModel(row.id));
  }

  deleteModel(id) {
    this.invalidateModel(id);
    this.db.prepare("UPDATE chat_sessions SET model_profile_id=NULL WHERE model_profile_id=?").run(String(id));
    if (this.getSetting("defaultModel") === String(id)) this.setSetting("defaultModel", "");
    return Number(this.db.prepare("DELETE FROM chat_models WHERE id = ?").run(String(id)).changes) > 0;
  }

  /** 追加当日额度计数（不存在则创建）。 */
  addUsage(sessionId, {day, requests = 1, tokensIn = 0, tokensOut = 0} = {}) {
    const key = day || this._today();
    this.db.prepare(
      "INSERT INTO chat_usage (session_id, day, requests, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(session_id, day) DO UPDATE SET requests = requests + excluded.requests, " +
      "tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out"
    ).run(String(sessionId), String(key), Number(requests) || 0, Number(tokensIn) || 0, Number(tokensOut) || 0);
    return this.getUsage(sessionId, key);
  }

  getUsage(sessionId, day) {
    const row = this.db.prepare("SELECT * FROM chat_usage WHERE session_id = ? AND day = ?").get(String(sessionId), String(day || this._today()));
    if (!row) return null;
    return {sessionId: row.session_id, day: row.day, requests: Number(row.requests), tokensIn: Number(row.tokens_in), tokensOut: Number(row.tokens_out)};
  }

  branchOf(sessionId) { return this.getSession(sessionId)?.characterId || ""; }

  claimEvent(sessionId, eventId) {
    if (!eventId) return true;
    return this.db.prepare("INSERT OR IGNORE INTO chat_receipts VALUES(?,?,?)").run(sessionId, String(eventId), this.now()).changes > 0;
  }

  connectionIdFor(endpoint, apiKeyEnv) { return "service-" + crypto.createHash("sha256").update(String(endpoint) + "\n" + String(apiKeyEnv)).digest("hex").slice(0, 16); }

  getConnection(id) {
    const row = this.db.prepare("SELECT * FROM chat_connections WHERE id=?").get(String(id));
    return row ? {id: row.id, label: row.label, endpoint: row.endpoint, apiKeyEnv: row.api_key_env} : null;
  }

  listConnections() { return this.db.prepare("SELECT id FROM chat_connections ORDER BY created_at,id").all().map(row => this.getConnection(row.id)); }

  saveConnection({id, label, endpoint, apiKeyEnv}) {
    this.db.prepare("INSERT INTO chat_connections VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,endpoint=excluded.endpoint,api_key_env=excluded.api_key_env,updated_at=excluded.updated_at").run(String(id), String(label || id), String(endpoint), String(apiKeyEnv), this.now(), this.now());
    for (const m of this.listModels().filter(m => m.connectionId === id)) this.invalidateModel(m.id);
    return this.getConnection(id);
  }

  deleteConnection(id) {
    if (this.listModels().some(m => m.connectionId === id)) throw Object.assign(new Error("Connection in use"), {publicMessage: "该连接仍有模型，先删除或迁移关联模型。"});
    return this.db.prepare("DELETE FROM chat_connections WHERE id=?").run(String(id)).changes > 0;
  }

  invalidateModel(id) {
    this.db.prepare("UPDATE chat_sessions SET epoch=epoch+1 WHERE model_profile_id=? OR model_profile_id IS NULL").run(String(id));
  }

  getSetting(key, fallback = null) { const row = this.db.prepare("SELECT payload FROM chat_settings WHERE key=?").get(key); return row ? JSON.parse(row.payload) : fallback; }
  setSetting(key, value) { this.db.prepare("INSERT INTO chat_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload").run(key, JSON.stringify(value)); }
  getOption(sessionId, key, fallback = null) { const row = this.db.prepare("SELECT payload FROM chat_options WHERE session_id=? AND key=?").get(sessionId, key); return row ? JSON.parse(row.payload) : fallback; }
  setOption(sessionId, key, value) { this.db.prepare("INSERT INTO chat_options VALUES(?,?,?) ON CONFLICT(session_id,key) DO UPDATE SET payload=excluded.payload").run(sessionId, key, JSON.stringify(value)); }

  reserveUsage(sessionId, day, limit) {
    const reserve = () => { if ((this.getUsage(sessionId, day)?.requests || 0) >= limit) return false; this.addUsage(sessionId, {day, requests: 1}); return true; };
    return typeof this.vault._transaction === "function" ? this.vault._transaction(reserve) : reserve();
  }

  listMemories(sessionId) { return this.db.prepare("SELECT id,text FROM chat_memories WHERE session_id=? ORDER BY id DESC LIMIT 40").all(sessionId).reverse(); }
  addMemory(sessionId, text) { return Number(this.db.prepare("INSERT INTO chat_memories(session_id,text,created_at) VALUES(?,?,?)").run(sessionId, text, this.now()).lastInsertRowid); }
  deleteMemory(sessionId, id) { return this.db.prepare("DELETE FROM chat_memories WHERE session_id=? AND id=?").run(sessionId, Number(id)).changes > 0; }

  _today() {
    const date = new Date(this.now());
    const pad = value => String(value).padStart(2, "0");
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }
}

export default ChatStore;
