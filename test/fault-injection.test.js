'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../src/db');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-fault-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('schema rejection is fail-closed and releases the SQLite handle', () => {
  const dir = tempDir();
  const dbPath = path.join(dir, 'legacy.sqlite');
  const seed = new DatabaseSync(dbPath);
  seed.exec('CREATE TABLE legacy(id INTEGER PRIMARY KEY); PRAGMA user_version=4;');
  seed.close();

  assert.throws(() => new Store(dbPath), error => error?.code === 'EDBSCHEMA');

  const moved = `${dbPath}.moved`;
  fs.renameSync(dbPath, moved);
  fs.renameSync(moved, dbPath);
  const verify = new DatabaseSync(dbPath);
  assert.equal(verify.prepare('PRAGMA user_version').get().user_version, 4);
  verify.close();
  cleanup(dir);
});

test('publication outbox survives a crash boundary without duplicating the durable item', () => {
  const dir = tempDir();
  const dbPath = path.join(dir, 'state.sqlite');
  let store = new Store(dbPath);
  const jobId = store.enqueue({ projectId: 1, mrIid: 1, headSha: 'head', trigger: 'open', dedupeKey: 'fault-job', maxQueueDepth: 10 });
  const runId = store.saveRunWithOutbox(
    jobId,
    { verdict: 'pass', summary: 'ok', coverageComplete: true, findings: [], usage: {} },
    1,
    { source: 'fault-test', fingerprint: 'policy' },
    [{ projectId: 1, mrIid: 1, type: 'summary', dedupeKey: 'fault:publication', payload: { ok: true } }]
  );
  const claimed = store.claimPublication();
  assert.equal(claimed.run_id, runId);
  assert.equal(claimed.dedupe_key, 'fault:publication');
  store.close();

  store = new Store(dbPath);
  assert.equal(store.recoverPublications(), 1);
  const retry = store.claimPublication();
  assert.equal(retry.id, claimed.id);
  assert.equal(retry.dedupe_key, 'fault:publication');
  store.finishPublication(retry.id, 'remote-summary');
  assert.equal(store.claimPublication(), null);
  assert.equal(store.publicationDepth(), 0);
  store.close();
  cleanup(dir);
});

test('notification outbox survives a crash boundary without duplicating the durable item', () => {
  const dir = tempDir();
  const dbPath = path.join(dir, 'state.sqlite');
  let store = new Store(dbPath);
  const id = store.enqueueNotification({
    routeName: 'ops',
    provider: 'wecom',
    secretRef: 'ops',
    eventType: 'service.degraded',
    dedupeKey: 'fault:notification',
    payload: { type: 'service.degraded', projectId: 1, mrIid: 2 }
  });
  const claimed = store.claimNotification();
  assert.equal(claimed.id, id);
  assert.equal(claimed.dedupe_key, 'fault:notification');
  store.close();

  store = new Store(dbPath);
  assert.equal(store.recoverNotifications(), 1);
  const retry = store.claimNotification();
  assert.equal(retry.id, id);
  assert.equal(retry.dedupe_key, 'fault:notification');
  store.finishNotification(id, 'remote-notification');
  assert.equal(store.claimNotification(), null);
  assert.equal(store.notificationDepth(), 0);
  store.close();
  cleanup(dir);
});
