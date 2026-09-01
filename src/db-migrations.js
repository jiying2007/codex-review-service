'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const CURRENT_SCHEMA_VERSION = 8;
const FINDING_RESOLUTIONS = Object.freeze(['fixed','false_positive','accepted_risk','duplicate','obsolete','not_applicable','policy_exception']);

function sqlString(value) { return `'${String(value).replace(/'/g, "''")}'`; }
function integrityCheck(db, phase = 'database') {
  const rows = db.prepare('PRAGMA integrity_check').all();
  const values = rows.flatMap(row => Object.values(row)).map(String);
  if (values.length !== 1 || values[0].toLowerCase() !== 'ok') {
    const error = new Error(`SQLite integrity_check failed during ${phase}: ${values.join('; ').slice(0,1000)}`);
    error.code = 'EDBINTEGRITY';
    error.details = values;
    throw error;
  }
  return true;
}
function migrationBackupPath(dbPath, fromVersion) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${dbPath}.schema${fromVersion}-${stamp}.bak`;
}
function verifyMigrationBackup(backupPath, fromVersion) {
  let backup;
  try {
    backup = new DatabaseSync(backupPath, { readOnly: true });
    integrityCheck(backup, 'migration-backup');
    const version = Number(backup.prepare('PRAGMA user_version').get().user_version);
    if (version !== Number(fromVersion)) {
      const error = new Error(`SQLite migration backup schema mismatch: expected ${fromVersion}, got ${version}.`);
      error.code = 'EDBMIGRATION';
      error.backupPath = backupPath;
      throw error;
    }
    return true;
  } finally {
    if (backup) backup.close();
  }
}
function createBackup(db, dbPath, fromVersion) {
  if (!dbPath || dbPath === ':memory:') {
    const error = new Error('Durable schema migration requires a filesystem-backed SQLite database.');
    error.code = 'EDBMIGRATION';
    throw error;
  }
  const backupPath = migrationBackupPath(dbPath, fromVersion);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  db.exec(`VACUUM INTO ${sqlString(backupPath)}`);
  fs.chmodSync(backupPath, 0o600);
  verifyMigrationBackup(backupPath, fromVersion);
  return backupPath;
}
function migrate5To6(db, dbPath, hooks = {}) {
  integrityCheck(db, 'pre-migration');
  const backupPath = createBackup(db, dbPath, 5);
  hooks.afterBackup?.({ backupPath, from: 5, to: 6 });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL,
        backup_path TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS finding_resolutions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        finding_id INTEGER NOT NULL REFERENCES review_findings(id) ON DELETE CASCADE,
        resolution TEXT NOT NULL CHECK(resolution IN ('fixed','false_positive','accepted_risk','duplicate','obsolete','not_applicable','policy_exception')),
        note TEXT NOT NULL DEFAULT '',
        actor TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_finding_resolutions_finding ON finding_resolutions(finding_id,id);
      CREATE INDEX IF NOT EXISTS idx_finding_resolutions_created ON finding_resolutions(created_at,id);
    `);
    hooks.afterDdl?.({ backupPath, from: 5, to: 6 });
    db.prepare('INSERT OR REPLACE INTO schema_migrations(version,applied_at,backup_path) VALUES(?,?,?)')
      .run(6, new Date().toISOString(), backupPath);
    db.exec('PRAGMA user_version=6');
    hooks.beforeCommit?.({ backupPath, from: 5, to: 6 });
    db.exec('COMMIT');
  } catch (cause) {
    try { db.exec('ROLLBACK'); } catch {}
    const error = new Error(`SQLite schema migration 5 -> 6 failed; original database remains authoritative and backup is ${backupPath}`);
    error.code = 'EDBMIGRATION';
    error.backupPath = backupPath;
    error.cause = cause;
    throw error;
  }
  integrityCheck(db, 'post-migration');
  return Object.freeze({ from: 5, to: 6, backupPath });
}

function migrate6To7(db, dbPath, hooks = {}) {
  integrityCheck(db, 'pre-migration');
  const backupPath = createBackup(db, dbPath, 6);
  hooks.afterBackup?.({ backupPath, from: 6, to: 7 });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS flow_state(
        project_id INTEGER NOT NULL,
        flow_type TEXT NOT NULL,
        external_id TEXT NOT NULL,
        ref TEXT NOT NULL DEFAULT '',
        previous_status TEXT NOT NULL DEFAULT '',
        current_status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        delivery_identity TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id,flow_type,external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_flow_state_updated ON flow_state(updated_at,project_id,flow_type);
    `);
    hooks.afterDdl?.({ backupPath, from: 6, to: 7 });
    db.prepare('INSERT OR REPLACE INTO schema_migrations(version,applied_at,backup_path) VALUES(?,?,?)').run(7, new Date().toISOString(), backupPath);
    db.exec('PRAGMA user_version=7');
    hooks.beforeCommit?.({ backupPath, from: 6, to: 7 });
    db.exec('COMMIT');
  } catch (cause) {
    try { db.exec('ROLLBACK'); } catch {}
    const error = new Error(`SQLite schema migration 6 -> 7 failed; original database remains authoritative and backup is ${backupPath}`);
    error.code = 'EDBMIGRATION'; error.backupPath = backupPath; error.cause = cause; throw error;
  }
  integrityCheck(db, 'post-migration');
  return Object.freeze({ from: 6, to: 7, backupPath });
}

function migrate7To8(db, dbPath, hooks = {}) {
  integrityCheck(db, 'pre-migration');
  const backupPath = createBackup(db, dbPath, 7);
  hooks.afterBackup?.({ backupPath, from: 7, to: 8 });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE notification_outbox ADD COLUMN aggregate_key TEXT GENERATED ALWAYS AS (json_extract(payload_json,'$._aggregateKey')) VIRTUAL;ALTER TABLE notification_outbox ADD COLUMN aggregate_until TEXT GENERATED ALWAYS AS (json_extract(payload_json,'$._aggregateUntil')) VIRTUAL;ALTER TABLE notification_outbox ADD COLUMN operation_type TEXT GENERATED ALWAYS AS (json_extract(payload_json,'$._operationType')) VIRTUAL;ALTER TABLE notification_outbox ADD COLUMN status_card_job_id INTEGER GENERATED ALWAYS AS (json_extract(payload_json,'$._statusCardJobId')) VIRTUAL;CREATE INDEX idx_notification_aggregate ON notification_outbox(status,aggregate_key,aggregate_until,id);CREATE INDEX idx_notification_operation ON notification_outbox(status,operation_type,status_card_job_id,route_name,id);CREATE INDEX idx_review_jobs_branch_head ON review_jobs(project_id,source_branch,head_sha,created_at);CREATE TABLE review_status_cards(job_id INTEGER NOT NULL REFERENCES review_jobs(id) ON DELETE CASCADE,route_name TEXT NOT NULL,provider TEXT NOT NULL,message_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'pending',error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(job_id,route_name));CREATE INDEX idx_review_status_cards_status ON review_status_cards(status,updated_at);`);
    hooks.afterDdl?.({ backupPath, from: 7, to: 8 });
    db.prepare('INSERT OR REPLACE INTO schema_migrations(version,applied_at,backup_path) VALUES(?,?,?)').run(8, new Date().toISOString(), backupPath);
    db.exec('PRAGMA user_version=8'); hooks.beforeCommit?.({ backupPath, from: 7, to: 8 }); db.exec('COMMIT');
  } catch (cause) { try { db.exec('ROLLBACK'); } catch {} const error = new Error(`SQLite schema migration 7 -> 8 failed; original database remains authoritative and backup is ${backupPath}`); error.code='EDBMIGRATION'; error.backupPath=backupPath; error.cause=cause; throw error; }
  integrityCheck(db, 'post-migration'); return Object.freeze({ from: 7, to: 8, backupPath });
}

const MIGRATIONS = Object.freeze(new Map([[5, migrate5To6],[6, migrate6To7],[7, migrate7To8]]));
function migrationPlan(fromVersion, toVersion = CURRENT_SCHEMA_VERSION) {
  const plan = [];
  let current = Number(fromVersion);
  while (current < toVersion) {
    const step = MIGRATIONS.get(current);
    if (!step) {
      const error = new Error(`No SQLite migration path from schema ${current} to ${toVersion}.`);
      error.code = 'EDBSCHEMA';
      throw error;
    }
    plan.push({ from: current, to: current + 1 });
    current += 1;
  }
  return Object.freeze(plan);
}
function migrateDatabase(db, dbPath, fromVersion, hooks = {}) {
  let current = Number(fromVersion);
  const applied = [];
  for (const step of migrationPlan(current)) {
    const migrate = MIGRATIONS.get(step.from);
    const result = migrate(db, dbPath, hooks);
    applied.push(result);
    current = step.to;
  }
  return Object.freeze({ from: Number(fromVersion), to: current, applied: Object.freeze(applied) });
}

module.exports = Object.freeze({
  CURRENT_SCHEMA_VERSION,
  FINDING_RESOLUTIONS,
  MIGRATIONS,
  integrityCheck,
  migrationBackupPath,
  verifyMigrationBackup,
  createBackup,
  migrationPlan,
  migrateDatabase,
  migrate5To6,
  migrate6To7,
  migrate7To8
});
