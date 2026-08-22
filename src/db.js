'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 2;
const TERMINAL_JOB_STATUSES = Object.freeze(['pass','needs_attention','blocked','incomplete','failed','superseded','cancelled','unauthorized','duplicate']);
function hasColumn(db, table, column) { return db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column); }
function isoAfter(ms) { return new Date(Date.now() + Math.max(0, ms)).toISOString(); }

class Store {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
  }
  withTransaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_events(id INTEGER PRIMARY KEY AUTOINCREMENT,webhook_id TEXT NOT NULL UNIQUE,event_type TEXT NOT NULL,project_id INTEGER,mr_iid INTEGER,received_at TEXT NOT NULL,processed_at TEXT);
      CREATE TABLE IF NOT EXISTS review_jobs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,project_id INTEGER NOT NULL,mr_iid INTEGER NOT NULL,base_sha TEXT NOT NULL DEFAULT '',start_sha TEXT NOT NULL DEFAULT '',head_sha TEXT NOT NULL DEFAULT '',dedupe_key TEXT NOT NULL,status TEXT NOT NULL,trigger TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,error_code TEXT,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,requested_by_user_id INTEGER,request_webhook_id TEXT,source_branch TEXT NOT NULL DEFAULT '',available_at TEXT NOT NULL DEFAULT '',UNIQUE(project_id,mr_iid,dedupe_key));
      CREATE TABLE IF NOT EXISTS review_runs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,job_id INTEGER NOT NULL REFERENCES review_jobs(id) ON DELETE CASCADE,verdict TEXT NOT NULL,summary TEXT NOT NULL,coverage_complete INTEGER NOT NULL,finding_count INTEGER NOT NULL,codex_version TEXT,duration_ms INTEGER NOT NULL,created_at TEXT NOT NULL,policy_source TEXT NOT NULL DEFAULT 'service-default',policy_fingerprint TEXT NOT NULL DEFAULT '<none>',chunk_count INTEGER NOT NULL DEFAULT 0,rejected_finding_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS review_findings(
        id INTEGER PRIMARY KEY AUTOINCREMENT,run_id INTEGER NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,severity TEXT NOT NULL,category TEXT NOT NULL,file TEXT NOT NULL,line INTEGER NOT NULL,end_line INTEGER NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,suggestion TEXT NOT NULL,confidence REAL NOT NULL,discussion_id TEXT,side TEXT NOT NULL DEFAULT 'new',UNIQUE(run_id,fingerprint));
    `);
    const jobColumns = [['start_sha',"TEXT NOT NULL DEFAULT ''"],['requested_by_user_id','INTEGER'],['request_webhook_id','TEXT'],['source_branch',"TEXT NOT NULL DEFAULT ''"],['available_at',"TEXT NOT NULL DEFAULT ''"]];
    for (const [column,type] of jobColumns) if (!hasColumn(this.db,'review_jobs',column)) this.db.exec(`ALTER TABLE review_jobs ADD COLUMN ${column} ${type}`);
    const runColumns = [['policy_source',"TEXT NOT NULL DEFAULT 'service-default'"],['policy_fingerprint',"TEXT NOT NULL DEFAULT '<none>'"],['chunk_count','INTEGER NOT NULL DEFAULT 0'],['rejected_finding_count','INTEGER NOT NULL DEFAULT 0']];
    for (const [column,type] of runColumns) if (!hasColumn(this.db,'review_runs',column)) this.db.exec(`ALTER TABLE review_runs ADD COLUMN ${column} ${type}`);
    if (!hasColumn(this.db,'review_findings','side')) this.db.exec("ALTER TABLE review_findings ADD COLUMN side TEXT NOT NULL DEFAULT 'new'");
    this.db.exec(`UPDATE review_jobs SET available_at=created_at WHERE available_at=''; CREATE INDEX IF NOT EXISTS idx_review_jobs_status_available ON review_jobs(status,available_at,id); CREATE INDEX IF NOT EXISTS idx_review_jobs_mr ON review_jobs(project_id,mr_iid,id); CREATE INDEX IF NOT EXISTS idx_review_runs_job ON review_runs(job_id,id); CREATE INDEX IF NOT EXISTS idx_webhooks_processed ON webhook_events(processed_at,received_at); PRAGMA user_version=${SCHEMA_VERSION};`);
  }
  schemaVersion() { return Number(this.db.prepare('PRAGMA user_version').get().user_version || 0); }
  ping() { return Number(this.db.prepare('SELECT 1 AS ok').get().ok) === 1; }
  recordWebhook({ webhookId,eventType,projectId=null,mrIid=null }) {
    try { this.db.prepare('INSERT INTO webhook_events(webhook_id,event_type,project_id,mr_iid,received_at) VALUES(?,?,?,?,?)').run(webhookId,eventType,projectId,mrIid,new Date().toISOString()); return true; }
    catch (error) { if (String(error.message).includes('UNIQUE constraint failed')) return false; throw error; }
  }
  markWebhookProcessed(webhookId) { this.db.prepare('UPDATE webhook_events SET processed_at=? WHERE webhook_id=?').run(new Date().toISOString(),webhookId); }
  forgetWebhook(webhookId) { this.db.prepare('DELETE FROM webhook_events WHERE webhook_id=? AND processed_at IS NULL').run(webhookId); }
  queueDepth() { return Number(this.db.prepare("SELECT COUNT(*) AS count FROM review_jobs WHERE status='queued'").get().count); }
  enqueue({ projectId,mrIid,baseSha='',startSha='',headSha='',sourceBranch='',trigger,dedupeKey,requestedByUserId=null,requestWebhookId=null,maxQueueDepth=Infinity }) {
    if (this.queueDepth() >= maxQueueDepth) { const error = new Error('Review queue is full'); error.code='EQUEUEFULL'; error.status=503; throw error; }
    const now = new Date().toISOString();
    return this.withTransaction(() => {
      if (headSha) this.db.prepare(`UPDATE review_jobs SET status='superseded',finished_at=? WHERE project_id=? AND mr_iid=? AND status='queued' AND (head_sha<>'' AND head_sha<>? OR (?<>'' AND start_sha<>'' AND start_sha<>?))`).run(now,projectId,mrIid,headSha,startSha,startSha);
      try {
        const result = this.db.prepare(`INSERT INTO review_jobs(project_id,mr_iid,base_sha,start_sha,head_sha,dedupe_key,status,trigger,created_at,available_at,requested_by_user_id,request_webhook_id,source_branch) VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?,?)`).run(projectId,mrIid,baseSha,startSha,headSha,dedupeKey,trigger,now,now,requestedByUserId,requestWebhookId,sourceBranch);
        return Number(result.lastInsertRowid);
      } catch (error) { if (String(error.message).includes('UNIQUE constraint failed')) return null; throw error; }
    });
  }
  bindJobSnapshot(id,{ baseSha,startSha,headSha,sourceBranch }) {
    const now = new Date().toISOString();
    return this.withTransaction(() => {
      const job = this.db.prepare('SELECT * FROM review_jobs WHERE id=?').get(id); if (!job) return {status:'missing'};
      if (job.trigger !== 'command') {
        const duplicate = this.db.prepare(`SELECT id,status FROM review_jobs WHERE project_id=? AND mr_iid=? AND start_sha=? AND head_sha=? AND id<>? AND trigger<>'command' ORDER BY id LIMIT 1`).get(job.project_id,job.mr_iid,startSha,headSha,id);
        if (duplicate) { this.db.prepare("UPDATE review_jobs SET status='duplicate',head_sha=?,base_sha=?,start_sha=?,source_branch=?,finished_at=? WHERE id=?").run(headSha,baseSha,startSha,sourceBranch||'',now,id); return {status:'duplicate',duplicateId:duplicate.id}; }
      }
      this.db.prepare('UPDATE review_jobs SET base_sha=?,start_sha=?,head_sha=?,source_branch=? WHERE id=?').run(baseSha||'',startSha||'',headSha,sourceBranch||'',id);
      this.db.prepare(`UPDATE review_jobs SET status='superseded',finished_at=? WHERE project_id=? AND mr_iid=? AND id<>? AND status='queued' AND (head_sha<>'' AND head_sha<>? OR (?<>'' AND start_sha<>'' AND start_sha<>?))`).run(now,job.project_id,job.mr_iid,id,headSha,startSha,startSha);
      return {status:'bound'};
    });
  }
  recoverInterruptedJobs() { return this.db.prepare("UPDATE review_jobs SET status='queued',started_at=NULL,error_code='ESERVICERESTART',available_at=? WHERE status='running'").run(new Date().toISOString()).changes; }
  claimNext() {
    return this.withTransaction(() => {
      const now = new Date().toISOString();
      const row = this.db.prepare(`SELECT j.* FROM review_jobs j WHERE j.status='queued' AND j.available_at<=? AND NOT EXISTS(SELECT 1 FROM review_jobs r WHERE r.project_id=j.project_id AND r.mr_iid=j.mr_iid AND r.status='running') ORDER BY j.id LIMIT 1`).get(now);
      if (!row) return null;
      const result = this.db.prepare("UPDATE review_jobs SET status='running',started_at=?,attempt=attempt+1 WHERE id=? AND status='queued'").run(now,row.id);
      return result.changes===1 ? this.db.prepare('SELECT * FROM review_jobs WHERE id=?').get(row.id) : null;
    });
  }
  getJob(id) { return this.db.prepare('SELECT * FROM review_jobs WHERE id=?').get(id)||null; }
  retryJob(id,errorCode,delayMs) { this.db.prepare("UPDATE review_jobs SET status='queued',error_code=?,started_at=NULL,available_at=? WHERE id=? AND status='running'").run(errorCode,isoAfter(delayMs),id); }
  requeueRunningJob(id,errorCode='ESHUTDOWN') { this.db.prepare("UPDATE review_jobs SET status='queued',error_code=?,started_at=NULL,available_at=? WHERE id=? AND status='running'").run(errorCode,new Date().toISOString(),id); }
  finishJob(id,status,errorCode=null) { this.db.prepare('UPDATE review_jobs SET status=?,error_code=?,finished_at=? WHERE id=?').run(status,errorCode,new Date().toISOString(),id); }
  cancelMergeRequest(projectId,mrIid,status='cancelled') { return this.db.prepare("UPDATE review_jobs SET status=?,finished_at=? WHERE project_id=? AND mr_iid=? AND status IN ('queued','running')").run(status,new Date().toISOString(),projectId,mrIid).changes; }
  saveRun(jobId,review,durationMs,policy) {
    return this.withTransaction(() => {
      const run = this.db.prepare(`INSERT INTO review_runs(job_id,verdict,summary,coverage_complete,finding_count,codex_version,duration_ms,created_at,policy_source,policy_fingerprint,chunk_count,rejected_finding_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(jobId,review.verdict,review.summary,review.coverageComplete?1:0,review.findings.length,review.codexVersion||null,durationMs,new Date().toISOString(),policy.source,policy.fingerprint,review.chunkCount||0,review.rejectedFindingCount||0);
      const runId=Number(run.lastInsertRowid); const insert=this.db.prepare(`INSERT INTO review_findings(run_id,fingerprint,severity,category,file,line,end_line,title,description,suggestion,confidence,side) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const f of review.findings) insert.run(runId,f.fingerprint,f.severity,f.category,f.file,f.line,f.endLine,f.title,f.description,f.suggestion,f.confidence,f.side);
      return runId;
    });
  }
  findingsForRun(runId) { return this.db.prepare('SELECT * FROM review_findings WHERE run_id=? ORDER BY id').all(runId); }
  priorFindings(projectId,mrIid,beforeRunId) { return this.db.prepare(`SELECT f.*,r.id AS run_id,j.id AS job_id FROM review_findings f JOIN review_runs r ON r.id=f.run_id JOIN review_jobs j ON j.id=r.job_id WHERE j.project_id=? AND j.mr_iid=? AND r.id<? ORDER BY r.id DESC,f.id`).all(projectId,mrIid,beforeRunId); }
  setDiscussionId(findingId,discussionId) { this.db.prepare('UPDATE review_findings SET discussion_id=? WHERE id=?').run(discussionId,findingId); }
  stats() { const rows=this.db.prepare('SELECT status,COUNT(*) AS count FROM review_jobs GROUP BY status').all(); return {jobs:Object.fromEntries(rows.map(r=>[r.status,Number(r.count)])),webhookCount:Number(this.db.prepare('SELECT COUNT(*) AS count FROM webhook_events').get().count),findings:Number(this.db.prepare('SELECT COUNT(*) AS count FROM review_findings').get().count),schemaVersion:this.schemaVersion()}; }
  prune({dataRetentionDays,webhookRetentionDays}) {
    const jobCutoff=new Date(Date.now()-dataRetentionDays*86400000).toISOString(); const webhookCutoff=new Date(Date.now()-webhookRetentionDays*86400000).toISOString();
    return this.withTransaction(()=>{ const webhooks=this.db.prepare('DELETE FROM webhook_events WHERE processed_at IS NOT NULL AND received_at<?').run(webhookCutoff).changes; const placeholders=TERMINAL_JOB_STATUSES.map(()=>'?').join(','); const jobs=this.db.prepare(`DELETE FROM review_jobs WHERE status IN (${placeholders}) AND finished_at IS NOT NULL AND finished_at<?`).run(...TERMINAL_JOB_STATUSES,jobCutoff).changes; return {webhooks,jobs}; });
  }
  checkpoint() { try { return this.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get(); } catch { return null; } }
  close() { this.db.close(); }
}
module.exports = { Store, SCHEMA_VERSION, TERMINAL_JOB_STATUSES };
