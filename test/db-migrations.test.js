'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { migrateDatabase, integrityCheck, verifyMigrationBackup, CURRENT_SCHEMA_VERSION } = require('../src/db-migrations');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-db5-'));
  const file = path.join(dir, 'review-service.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE review_jobs(id INTEGER PRIMARY KEY,project_id INTEGER NOT NULL DEFAULT 1,source_branch TEXT NOT NULL DEFAULT '',head_sha TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z');
    CREATE TABLE notification_outbox(id INTEGER PRIMARY KEY,route_name TEXT NOT NULL DEFAULT '',payload_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'pending');
    CREATE TABLE review_findings(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
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
      side TEXT NOT NULL DEFAULT 'new',
      anchor_hash TEXT NOT NULL DEFAULT '',
      UNIQUE(run_id,fingerprint)
    );
    INSERT INTO review_findings(run_id,fingerprint,severity,category,file,line,end_line,title,description,suggestion,confidence)
    VALUES(1,'fp-1','high','correctness','src/a.c',10,10,'bad','desc','fix',0.9);
    PRAGMA user_version=5;
  `);
  db.close();
  return { dir, file };
}

test('Schema 5 migrates transactionally through 8 with verified backups and preserved data', () => {
  const { dir, file } = fixture();
  const db = new DatabaseSync(file);
  try {
    const result = migrateDatabase(db, file, 5);
    assert.equal(result.to, CURRENT_SCHEMA_VERSION);
    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), CURRENT_SCHEMA_VERSION);
    assert.equal(db.prepare('SELECT title FROM review_findings WHERE id=1').get().title, 'bad');
    const backupPath = result.applied[0].backupPath;
    assert.ok(fs.existsSync(backupPath));
    assert.equal(verifyMigrationBackup(backupPath, 5), true);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try { assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 5); }
    finally { backup.close(); }
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='finding_resolutions'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='flow_state'").get().count, 1);
    assert.deepEqual(result.applied.map(step => [step.from, step.to]), [[5,6],[6,7],[7,8]]);
    assert.equal(db.prepare('SELECT version FROM schema_migrations WHERE version=6').get().version, 6);
    assert.equal(db.prepare('SELECT version FROM schema_migrations WHERE version=7').get().version, 7);
    assert.equal(db.prepare('SELECT version FROM schema_migrations WHERE version=8').get().version, 8);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='review_status_cards'").get().count, 1);
    assert.ok(fs.existsSync(result.applied[1].backupPath));
    assert.equal(verifyMigrationBackup(result.applied[1].backupPath, 6), true);
    assert.equal(integrityCheck(db), true);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migration backup verification rejects schema mismatch and releases the read-only handle', () => {
  const { dir, file } = fixture();
  try {
    assert.throws(() => verifyMigrationBackup(file, 6), error => error?.code === 'EDBMIGRATION');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration fault rolls DDL back and preserves schema 5 plus backup', () => {
  const { dir, file } = fixture();
  const db = new DatabaseSync(file);
  let backupPath = '';
  try {
    assert.throws(() => migrateDatabase(db, file, 5, {
      afterBackup(info) { backupPath = info.backupPath; },
      afterDdl() { throw new Error('injected migration failure'); }
    }), error => error?.code === 'EDBMIGRATION');
    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 5);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='finding_resolutions'").get().count, 0);
    assert.equal(db.prepare('SELECT title FROM review_findings WHERE id=1').get().title, 'bad');
    assert.ok(backupPath && fs.existsSync(backupPath));
    assert.equal(verifyMigrationBackup(backupPath, 5), true);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unsupported migration path fails closed', () => {
  const db = new DatabaseSync(':memory:');
  try { assert.throws(() => migrateDatabase(db, ':memory:', 4), error => error?.code === 'EDBSCHEMA'); }
  finally { db.close(); }
});

test('Schema 7 to 8 migration creates indexed status-card and aggregation state with a verified backup',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-review-db7-')),file=path.join(dir,'review-service.sqlite'),db=new DatabaseSync(file);try{db.exec("CREATE TABLE review_jobs(id INTEGER PRIMARY KEY,project_id INTEGER NOT NULL DEFAULT 1,source_branch TEXT NOT NULL DEFAULT '',head_sha TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z');CREATE TABLE notification_outbox(id INTEGER PRIMARY KEY,route_name TEXT NOT NULL DEFAULT '',payload_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'pending');CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL,backup_path TEXT NOT NULL DEFAULT '');PRAGMA user_version=7;");const result=migrateDatabase(db,file,7);assert.equal(result.to,8);assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='review_status_cards'").get().name,'review_status_cards');const columns=new Set(db.prepare('PRAGMA table_xinfo(notification_outbox)').all().map(row=>row.name));for(const name of['aggregate_key','aggregate_until','operation_type','status_card_job_id'])assert.ok(columns.has(name));assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_notification_aggregate'").get().name,'idx_notification_aggregate');assert.equal(verifyMigrationBackup(result.applied[0].backupPath,7),true);}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}});
