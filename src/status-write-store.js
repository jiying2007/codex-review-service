'use strict';

const { createHash } = require('node:crypto');

const STATUS_WRITE_SCHEMA = `
  CREATE TABLE status_publication_targets(
    target_key TEXT PRIMARY KEY,
    identity_json TEXT NOT NULL,
    latest_outbox_id INTEGER NOT NULL,
    latest_job_id INTEGER,
    latest_item_json TEXT NOT NULL,
    projection_state TEXT NOT NULL CHECK(projection_state IN ('pending','published','uncertain','stale','failed')),
    latest_remote_id TEXT NOT NULL DEFAULT '',
    repair_attempts INTEGER NOT NULL DEFAULT 0,
    reconcile_attempts INTEGER NOT NULL DEFAULT 0,
    observation_json TEXT NOT NULL DEFAULT '{}',
    observed_at TEXT,
    error_code TEXT,
    next_reconcile_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE status_write_attempts(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_key TEXT NOT NULL REFERENCES status_publication_targets(target_key) ON DELETE RESTRICT,
    outbox_id INTEGER NOT NULL,
    job_id INTEGER,
    payload_json TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('started','acknowledged','rejected','uncertain')),
    remote_id TEXT NOT NULL DEFAULT '',
    error_code TEXT,
    http_status INTEGER,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX idx_status_write_uncertainty ON status_write_attempts(target_key,outcome,id);
  CREATE INDEX idx_status_target_reconcile ON status_publication_targets(projection_state,next_reconcile_at);
`;

const UNRESOLVED_STATUS_ATTEMPT_PREDICATE = "(target_key=? OR target_key IN(SELECT target_key FROM status_publication_targets WHERE json_extract(identity_json,'$.scopeUnknown')=1)) AND outcome IN ('started','uncertain')";

function statusTarget(item, config) {
  const p = item.payload || {};
  // An implicit and an explicit pipeline can alias the same GitLab status.
  // The uncertainty domain therefore deliberately does not contain pipelineId or MR.
  const identity = {
    apiUrl: String(config.gitlabApiUrl || ''), projectId: Number(p.statusProjectId),
    headSha: String(p.headSha || ''), ref: String(p.ref || ''),
    statusName: String(p.statusName ?? config.statusName ?? '')
  };
  return { key: createHash('sha256').update(JSON.stringify(identity)).digest('hex'), identity };
}

function definitelyRejected(error) {
  return error?.code === 'EGITLABHTTP' && [400,401,403,404,405,409,410,422,425,429].includes(Number(error.status));
}

function legacyStatusUncertain(row) {
  if (['EADMINRETRY','ESERVICERESTART'].includes(row.error_code) || ['publishing','uncertain'].includes(row.status) || Number(row.attempt) > 1) return true;
  if (Number(row.attempt) === 1 && row.status === 'published' && !row.error_code && /^[1-9]\d*$/.test(String(row.remote_id || ''))) return false;
  if (Number(row.attempt) === 1 && ['ESTALEPUBLICATION','EPROJECTNOTALLOWED','EGITLABCIRCUIT'].includes(row.error_code)) return false;
  // The old outbox discarded HTTP status and the transport phase. In particular,
  // JSON/output errors and HTTP 5xx may follow a committed write, so no generic
  // legacy HTTP error can be treated as a proven rejection.
  return Number(row.attempt) > 0 || Boolean(row.error_code) || row.status !== 'pending';
}

class StatusWriteStore {
  constructor(store) { this.store = store; this.db = store.db; }
  boundJob(item) {
    const job = this.store.statusPublicationJob(item), p = item.payload || {};
    return job && Number(job.project_id) === Number(item.project_id) && Number(job.mr_iid) === Number(item.mr_iid) &&
      String(job.head_sha) === String(p.headSha) && String(job.source_branch || '') === String(p.ref || '') &&
      Number(job.status_project_id || job.project_id) === Number(p.statusProjectId) ? job : null;
  }
  target(key) {
    const row = this.db.prepare('SELECT * FROM status_publication_targets WHERE target_key=?').get(key);
    return row ? { ...row, identity: JSON.parse(row.identity_json), item: JSON.parse(row.latest_item_json), observation: JSON.parse(row.observation_json) } : null;
  }
  unresolved(key) {
    return Number(this.db.prepare(`SELECT COUNT(*) count FROM status_write_attempts WHERE ${UNRESOLVED_STATUS_ATTEMPT_PREDICATE}`).get(key).count);
  }
  registerOrphan(item, config) {
    const { key, identity } = statusTarget(item, config), now = new Date().toISOString();
    // No job or target identity is invented. Missing target fields conservatively
    // fence the whole store; they cannot silently become a distinct safe target.
    if (!Number.isSafeInteger(identity.projectId) || identity.projectId <= 0 || !identity.headSha || !identity.statusName || typeof item.payload.ref !== 'string') identity.scopeUnknown = true;
    this.db.prepare(`INSERT OR IGNORE INTO status_publication_targets(target_key,identity_json,latest_outbox_id,latest_job_id,latest_item_json,projection_state,error_code,next_reconcile_at,created_at,updated_at)
      VALUES(?,?,?,NULL,?,'uncertain','ELEGACYSTATUSORPHAN',?,?,?)`)
      .run(key, JSON.stringify(identity), item.id, JSON.stringify(item), now, now, now);
    if (identity.scopeUnknown) this.db.prepare("UPDATE status_publication_targets SET identity_json=json_set(identity_json,'$.scopeUnknown',1) WHERE target_key=?").run(key);
    return key;
  }
  register(item, config) {
    const { key, identity } = statusTarget(item, config), job = this.boundJob(item);
    if (!job) throw Object.assign(new Error('Status publication has no durable job'), { code: 'EDBSTATE' });
    const now = new Date().toISOString(), previous = this.target(key);
    if (previous && (previous.latest_job_id > job.id || (previous.latest_job_id === job.id && previous.latest_outbox_id > item.id))) {
      throw Object.assign(new Error('Status generation has been superseded'), { code: 'ESTALEPUBLICATION' });
    }
    const current = previous?.latest_outbox_id === item.id;
    const storedItem = { id: item.id, run_id: item.run_id, project_id: item.project_id, mr_iid: item.mr_iid,
      action_type: item.action_type, dedupe_key: item.dedupe_key,
      payload: { ...item.payload, jobId: job.id, startSha: item.payload.startSha ?? job.start_sha, statusName: identity.statusName } };
    this.db.prepare(`INSERT INTO status_publication_targets(target_key,identity_json,latest_outbox_id,latest_job_id,latest_item_json,projection_state,latest_remote_id,repair_attempts,next_reconcile_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(target_key) DO UPDATE SET latest_outbox_id=excluded.latest_outbox_id,latest_job_id=excluded.latest_job_id,latest_item_json=excluded.latest_item_json,projection_state=excluded.projection_state,latest_remote_id=excluded.latest_remote_id,repair_attempts=excluded.repair_attempts,next_reconcile_at=excluded.next_reconcile_at,updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(identity), item.id, job.id, JSON.stringify(storedItem), this.unresolved(key) ? 'uncertain' : 'pending',
        current ? previous.latest_remote_id : '', current ? previous.repair_attempts : 0, now, previous?.created_at || now, now);
    return key;
  }
  begin(item, config, { repair = false } = {}) {
    return this.store.withTransaction(() => {
      if (!this.store.isCurrentStatusPublication(item)) throw Object.assign(new Error('Status generation has been superseded'), { code: 'ESTALEPUBLICATION' });
      const row = this.db.prepare('SELECT status FROM publication_outbox WHERE id=?').get(item.id);
      if (!row || !['publishing', ...(repair ? ['uncertain','published'] : [])].includes(row.status)) {
        throw Object.assign(new Error('Status outbox item is not writable'), { code: 'EDBSTATE' });
      }
      const key = this.register(item, config), now = new Date().toISOString();
      if (!item.payload.statusPublicationProtocol) {
        item.payload.statusPublicationProtocol = 1;
        this.db.prepare('UPDATE publication_outbox SET payload_json=? WHERE id=?').run(JSON.stringify(item.payload), item.id);
      }
      const result = this.db.prepare("INSERT INTO status_write_attempts(target_key,outbox_id,job_id,payload_json,outcome,started_at) VALUES(?,?,?,?,'started',?)")
        .run(key, item.id, this.store.statusPublicationJob(item).id, JSON.stringify(item.payload), now);
      return { id: Number(result.lastInsertRowid), key };
    });
  }
  settle(attempt, { result, error } = {}) {
    if (!attempt) return;
    const remoteId = String(result?.id || ''), acknowledged = !error && /^[1-9]\d*$/.test(remoteId);
    const outcome = acknowledged ? 'acknowledged' : definitelyRejected(error) ? 'rejected' : 'uncertain';
    const code = error?.code || (acknowledged ? null : 'EGITLABSTATUSIDENTITY'), now = new Date().toISOString();
    return this.store.withTransaction(() => {
      const row = this.db.prepare('SELECT outbox_id FROM status_write_attempts WHERE id=? AND outcome=\'started\'').get(attempt.id);
      if (!row) return;
      this.db.prepare('UPDATE status_write_attempts SET outcome=?,remote_id=?,error_code=?,http_status=?,finished_at=? WHERE id=? AND outcome=\'started\'')
        .run(outcome, acknowledged ? remoteId : '', code, Number(error?.status) || null, now, attempt.id);
      if (acknowledged) this.db.prepare('UPDATE status_publication_targets SET latest_remote_id=?,updated_at=? WHERE target_key=? AND latest_outbox_id=?').run(remoteId, now, attempt.key, row.outbox_id);
      if (outcome === 'uncertain') {
        this.db.prepare("UPDATE status_publication_targets SET projection_state='uncertain',error_code='ESTATUSUNCERTAIN',updated_at=? WHERE target_key=?").run(now, attempt.key);
        // A newly acknowledged generation must not conceal an older unknown write.
        this.db.prepare("UPDATE publication_outbox SET status='uncertain',error_code='ESTATUSUNCERTAIN',finished_at=NULL WHERE id=(SELECT latest_outbox_id FROM status_publication_targets WHERE target_key=?) AND status='published'").run(attempt.key);
      }
      return { outcome, remoteId: acknowledged ? remoteId : '' };
    });
  }
  complete(item, config, remoteId, delayMs) {
    return this.store.withTransaction(() => {
      const { key } = statusTarget(item, config), target = this.target(key);
      if (!target || target.latest_outbox_id !== item.id) throw Object.assign(new Error('Status publication intent is missing'), { code: 'ESTATUSPROTOCOL' });
      const uncertain = this.unresolved(key) > 0;
      this.db.prepare('UPDATE status_publication_targets SET projection_state=?,error_code=?,next_reconcile_at=?,updated_at=? WHERE target_key=?')
        .run(uncertain ? 'uncertain' : 'published', uncertain ? 'ESTATUSUNCERTAIN' : null, new Date(Date.now() + delayMs).toISOString(), new Date().toISOString(), key);
      this.db.prepare('UPDATE publication_outbox SET status=?,remote_id=?,error_code=?,finished_at=? WHERE id=?')
        .run(uncertain ? 'uncertain' : 'published', String(remoteId || ''), uncertain ? 'ESTATUSUNCERTAIN' : null, uncertain ? null : new Date().toISOString(), item.id);
      return { uncertain, key };
    });
  }
  hold(item, config, code, delayMs) {
    const { key } = statusTarget(item, config);
    const target = this.target(key);
    if (!target) return false;
    if (!this.unresolved(key) && !(target?.latest_outbox_id === item.id && target.latest_remote_id)) return false;
    this.store.withTransaction(() => {
      this.db.prepare("UPDATE status_publication_targets SET projection_state='uncertain',error_code=?,next_reconcile_at=?,updated_at=? WHERE target_key=?")
        .run(code, new Date(Date.now() + delayMs).toISOString(), new Date().toISOString(), key);
      this.db.prepare("UPDATE publication_outbox SET status='uncertain',error_code=?,finished_at=NULL WHERE id=? AND status IN ('publishing','pending','published')")
        .run(code, item.id);
    });
    return true;
  }
  recover() {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE status_write_attempts SET outcome='uncertain',error_code='ESERVICERESTART',finished_at=? WHERE outcome='started'").run(now);
    this.db.prepare("UPDATE status_publication_targets SET projection_state='uncertain',error_code='ESTATUSCONFIRMATION',next_reconcile_at=?,updated_at=? WHERE projection_state='pending' AND latest_remote_id<>''").run(now, now);
    this.db.prepare("UPDATE status_publication_targets SET projection_state='uncertain',error_code='ESTATUSUNCERTAIN',next_reconcile_at=?,updated_at=? WHERE EXISTS(SELECT 1 FROM status_write_attempts a WHERE a.target_key=status_publication_targets.target_key AND a.outcome='uncertain')").run(now, now);
    this.db.prepare("UPDATE publication_outbox SET status='uncertain',error_code='ESTATUSUNCERTAIN',finished_at=NULL WHERE id IN(SELECT latest_outbox_id FROM status_publication_targets WHERE projection_state='uncertain') AND status IN ('publishing','pending','published')").run();
  }
  adoptLegacy(config) {
    // Preserve inferable legacy uncertainty before mutable retries can hide it.
    const rows = this.db.prepare("SELECT * FROM publication_outbox WHERE action_type IN ('status','cancel_status') AND (attempt>0 OR error_code IS NOT NULL OR status<>'pending') AND json_extract(payload_json,'$.statusPublicationProtocol') IS NULL ORDER BY id").all();
    this.store.withTransaction(() => {
      for (const row of rows) {
        const payload = JSON.parse(row.payload_json), item = { ...row, payload }, uncertain = legacyStatusUncertain(row);
        payload.statusPublicationProtocol = 1;
        this.db.prepare('UPDATE publication_outbox SET payload_json=? WHERE id=?').run(JSON.stringify(payload), row.id);
        if (!uncertain) continue;
        const job = this.boundJob(item);
        const { key } = statusTarget(item, config), now = new Date().toISOString();
        if (!job) this.registerOrphan(item, config);
        else if (!this.target(key)) this.register(item, config);
        this.db.prepare("INSERT INTO status_write_attempts(target_key,outbox_id,job_id,payload_json,outcome,error_code,started_at,finished_at) VALUES(?,?,?,?,'uncertain','ELEGACYSTATUSUNCERTAIN',?,?)")
          .run(key, row.id, job?.id || null, JSON.stringify(payload), row.started_at || row.created_at, now);
        this.db.prepare("UPDATE status_publication_targets SET projection_state='uncertain',error_code='ELEGACYSTATUSUNCERTAIN' WHERE target_key=?").run(key);
        this.db.prepare("UPDATE publication_outbox SET status='uncertain',error_code=?,finished_at=NULL WHERE id=?").run(job ? 'ELEGACYSTATUSUNCERTAIN' : 'ELEGACYSTATUSORPHAN', row.id);
      }
      for (const row of this.db.prepare('SELECT target_key FROM status_publication_targets').all()) {
        if (this.unresolved(row.target_key)) this.db.prepare("UPDATE status_publication_targets SET projection_state='uncertain' WHERE target_key=?").run(row.target_key);
      }
      this.db.prepare("UPDATE publication_outbox SET status='uncertain',error_code='ESTATUSUNCERTAIN',finished_at=NULL WHERE status='published' AND id IN(SELECT latest_outbox_id FROM status_publication_targets WHERE projection_state='uncertain')").run();
      // A newer legacy acknowledged row is still subject to an older unknown request.
      for (const row of rows) {
        const item = { ...row, payload: JSON.parse(row.payload_json) }, { key } = statusTarget(item, config);
        const target = this.target(key), job = this.store.statusPublicationJob(item);
        if (this.unresolved(key) && this.store.isCurrentStatusPublication(item) && (!target || target.latest_job_id < job.id || (target.latest_job_id === job.id && target.latest_outbox_id <= item.id))) {
          this.register(item, config);
          this.db.prepare("UPDATE publication_outbox SET status='uncertain',error_code='ELEGACYSTATUSUNCERTAIN',finished_at=NULL WHERE id=?").run(row.id);
        }
      }
    });
  }
  claimDue(delayMs) {
    return this.store.withTransaction(() => {
      const now = new Date().toISOString(), row = this.db.prepare("SELECT target_key FROM status_publication_targets WHERE projection_state='uncertain' AND next_reconcile_at<=? ORDER BY next_reconcile_at,target_key LIMIT 1").get(now);
      if (!row) return null;
      this.db.prepare('UPDATE status_publication_targets SET next_reconcile_at=?,reconcile_attempts=reconcile_attempts+1 WHERE target_key=?').run(new Date(Date.now() + delayMs).toISOString(), row.target_key);
      return this.target(row.target_key);
    });
  }
  observe(key, observation, delayMs, errorCode = null) {
    this.db.prepare('UPDATE status_publication_targets SET observation_json=?,observed_at=?,error_code=?,next_reconcile_at=?,updated_at=? WHERE target_key=?')
      .run(JSON.stringify(observation), new Date().toISOString(), errorCode || 'ESTATUSUNCERTAIN', new Date(Date.now() + delayMs).toISOString(), new Date().toISOString(), key);
  }
  reserveRepair(key, outboxId, maxAttempts) {
    return this.db.prepare('UPDATE status_publication_targets SET repair_attempts=repair_attempts+1 WHERE target_key=? AND latest_outbox_id=? AND repair_attempts<?').run(key, outboxId, maxAttempts).changes === 1;
  }
  stale(key, code = 'ESTALEPUBLICATION') {
    // Staleness stops writes, but never deletes or resolves unknown attempts.
    this.db.prepare("UPDATE status_publication_targets SET projection_state='stale',error_code=?,updated_at=? WHERE target_key=?").run(code, new Date().toISOString(), key);
    if (!this.unresolved(key)) this.db.prepare("UPDATE publication_outbox SET status='cancelled',error_code=?,finished_at=? WHERE id=(SELECT latest_outbox_id FROM status_publication_targets WHERE target_key=?) AND status='uncertain'").run(code, new Date().toISOString(), key);
  }
  summary() {
    return { unresolvedAttempts: Number(this.db.prepare("SELECT COUNT(*) count FROM status_write_attempts WHERE outcome IN ('started','uncertain')").get().count),
      uncertainTargets: Number(this.db.prepare("SELECT COUNT(*) count FROM status_publication_targets t WHERE t.projection_state='uncertain' OR EXISTS(SELECT 1 FROM status_write_attempts a WHERE a.target_key=t.target_key AND a.outcome IN ('started','uncertain'))").get().count) };
  }
}

module.exports = { STATUS_WRITE_SCHEMA, StatusWriteStore, statusTarget, definitelyRejected, legacyStatusUncertain, UNRESOLVED_STATUS_ATTEMPT_PREDICATE };
