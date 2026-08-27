'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { migrateDatabase, integrityCheck, CURRENT_SCHEMA_VERSION } = require('../src/db-migrations');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-db5-'));
  const file = path.join(dir, 'review-service.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys=ON;
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

test('Schema 5 migrates transactionally to 6 with verified backup and preserved data', () => {
  const { dir, file } = fixture();
  const db = new DatabaseSync(file);
  try {
    const result = migrateDatabase(db, file, 5);
    assert.equal(result.to, CURRENT_SCHEMA_VERSION);
    assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 6);
    assert.equal(db.prepare('SELECT title FROM review_findings WHERE id=1').get().title, 'bad');
    assert.ok(fs.existsSync(result.applied[0].backupPath));
    assert.equal(new DatabaseSync(result.applied[0].backupPath, { readOnly: true }).prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='finding_resolutions'").get().count, 1);
    assert.equal(db.prepare('SELECT version FROM schema_migrations WHERE version=6').get().version, 6);
    assert.equal(integrityCheck(db), true);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
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
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unsupported migration path fails closed', () => {
  const db = new DatabaseSync(':memory:');
  try { assert.throws(() => migrateDatabase(db, ':memory:', 4), error => error?.code === 'EDBSCHEMA'); }
  finally { db.close(); }
});
