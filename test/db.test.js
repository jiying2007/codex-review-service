'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/db');

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-db-'));
  const store = new Store(path.join(dir, 'test.sqlite'));
  try { return fn(store); }
  finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('deduplicates webhook delivery ids', () => withStore(store => {
  const event = { webhookId: 'id-1', eventType: 'Merge Request Hook', projectId: 1, mrIid: 2 };
  assert.equal(store.recordWebhook(event), true);
  assert.equal(store.recordWebhook(event), false);
  store.forgetWebhook('id-1');
  assert.equal(store.recordWebhook(event), true);
}));

test('deduplicates automatic same-head reviews but allows explicit manual rereviews', () => withStore(store => {
  const first = store.enqueue({ projectId: 1, mrIid: 2, headSha: 'aaa', trigger: 'open' });
  assert.ok(first);
  assert.equal(store.enqueue({ projectId: 1, mrIid: 2, headSha: 'aaa', trigger: 'update' }), null);
  const manual = store.enqueue({ projectId: 1, mrIid: 2, headSha: 'aaa', trigger: 'command', dedupeKey: 'command:webhook-2' });
  assert.ok(manual);
}));

test('supersedes old heads and recovers interrupted work', () => withStore(store => {
  const first = store.enqueue({ projectId: 1, mrIid: 2, headSha: 'aaa', trigger: 'open' });
  const second = store.enqueue({ projectId: 1, mrIid: 2, headSha: 'bbb', trigger: 'update' });
  assert.ok(first && second);
  assert.equal(store.db.prepare('SELECT status FROM review_jobs WHERE id=?').get(first).status, 'superseded');
  const next = store.claimNext();
  assert.equal(next.id, second);
  assert.equal(next.status, 'running');
  assert.equal(store.recoverInterruptedJobs(), 1);
  assert.equal(store.claimNext().id, second);
}));
