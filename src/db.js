'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class Store {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;');
    this.migrate();
  }

  withTransaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        project_id INTEGER,
        mr_iid INTEGER,
        received_at TEXT NOT NULL,
        processed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS review_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        mr_iid INTEGER NOT NULL,
        base_sha TEXT NOT NULL DEFAULT '',
        head_sha TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(project_id, mr_iid, head_sha)
      );

      CREATE INDEX IF NOT EXISTS idx_review_jobs_status ON review_jobs(status, id);
      CREATE INDEX IF NOT EXISTS idx_review_jobs_mr ON review_jobs(project_id, mr_iid, id);

      CREATE TABLE IF NOT EXISTS review_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES review_jobs(id) ON DELETE CASCADE,
        verdict TEXT NOT NULL,
        summary TEXT NOT NULL,
        coverage_complete INTEGER NOT NULL,
        finding_count INTEGER NOT NULL,
        codex_version TEXT,
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS review_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        suggestion TEXT NOT NULL,
        confidence REAL NOT NULL,
        discussion_id TEXT,
        UNIQUE(run_id, fingerprint)
      );
    `);
  }

  recordWebhook({ webhookId, eventType, projectId = null, mrIid = null }) {
    const now = new Date().toISOString();
    try {
      this.db.prepare('INSERT INTO webhook_events(webhook_id,event_type,project_id,mr_iid,received_at) VALUES(?,?,?,?,?)')
        .run(webhookId, eventType, projectId, mrIid, now);
      return true;
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) return false;
      throw error;
    }
  }

  markWebhookProcessed(webhookId) {
    this.db.prepare('UPDATE webhook_events SET processed_at=? WHERE webhook_id=?')
      .run(new Date().toISOString(), webhookId);
  }

  enqueue({ projectId, mrIid, baseSha = '', headSha, trigger }) {
    const now = new Date().toISOString();
    return this.withTransaction(() => {
      this.db.prepare(`UPDATE review_jobs SET status='superseded', finished_at=?
        WHERE project_id=? AND mr_iid=? AND head_sha<>? AND status IN ('queued','running')`)
        .run(now, projectId, mrIid, headSha);
      try {
        const result = this.db.prepare(`INSERT INTO review_jobs(project_id,mr_iid,base_sha,head_sha,status,trigger,created_at)
          VALUES(?,?,?,?, 'queued', ?, ?)`)
          .run(projectId, mrIid, baseSha, headSha, trigger, now);
        return Number(result.lastInsertRowid);
      } catch (error) {
        if (String(error.message).includes('UNIQUE constraint failed')) return null;
        throw error;
      }
    });
  }

  claimNext() {
    return this.withTransaction(() => {
      const row = this.db.prepare("SELECT * FROM review_jobs WHERE status='queued' ORDER BY id LIMIT 1").get();
      if (!row) return null;
      const result = this.db.prepare("UPDATE review_jobs SET status='running', started_at=?, attempt=attempt+1 WHERE id=? AND status='queued'")
        .run(new Date().toISOString(), row.id);
      return result.changes === 1 ? this.db.prepare('SELECT * FROM review_jobs WHERE id=?').get(row.id) : null;
    });
  }

  finishJob(id, status, errorCode = null) {
    this.db.prepare('UPDATE review_jobs SET status=?, error_code=?, finished_at=? WHERE id=?')
      .run(status, errorCode, new Date().toISOString(), id);
  }

  saveRun(jobId, review, durationMs) {
    const now = new Date().toISOString();
    return this.withTransaction(() => {
      const run = this.db.prepare(`INSERT INTO review_runs(job_id,verdict,summary,coverage_complete,finding_count,codex_version,duration_ms,created_at)
        VALUES(?,?,?,?,?,?,?,?)`)
        .run(jobId, review.verdict, review.summary, review.coverageComplete ? 1 : 0,
          review.findings.length, review.codexVersion || null, durationMs, now);
      const runId = Number(run.lastInsertRowid);
      const insert = this.db.prepare(`INSERT INTO review_findings(run_id,fingerprint,severity,category,file,line,end_line,title,description,suggestion,confidence)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
      for (const f of review.findings) {
        insert.run(runId, f.fingerprint, f.severity, f.category, f.file, f.line, f.endLine,
          f.title, f.description, f.suggestion, f.confidence);
      }
      return runId;
    });
  }

  findingsForRun(runId) {
    return this.db.prepare('SELECT * FROM review_findings WHERE run_id=? ORDER BY id').all(runId);
  }

  latestFindings(projectId, mrIid, beforeJobId) {
    return this.db.prepare(`SELECT f.* FROM review_findings f
      JOIN review_runs r ON r.id=f.run_id JOIN review_jobs j ON j.id=r.job_id
      WHERE j.project_id=? AND j.mr_iid=? AND j.id<?
      ORDER BY j.id DESC, f.id`).all(projectId, mrIid, beforeJobId);
  }

  setDiscussionId(findingId, discussionId) {
    this.db.prepare('UPDATE review_findings SET discussion_id=? WHERE id=?').run(discussionId, findingId);
  }

  queueDepth() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM review_jobs WHERE status='queued'").get().count);
  }

  close() { this.db.close(); }
}

module.exports = { Store };
