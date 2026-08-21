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
}));

test('deduplicates same MR head and supersedes older queued head', () => withStore(store => {
  const first = store.enqueue({ projectId: 1, mrIid: 2, headSha: 'aaa', trigger: 'open' });
  assert.ok(first);
  assert.equal(store.enqueue({ projectId: 1, mrIid: 2, headSha: 'aaa', trigger: 'update' }), null);
  const second = store.enqueue({ projectId: 1, mrIid: 2, headSha: 'bbb', trigger: 'update' });
  assert.ok(second);
  const old = store.db.prepare('SELECT status FROM review_jobs WHERE id=?').get(first);
  assert.equal(old.status, 'superseded');
  const next = store.claimNext();
  assert.equal(next.id, second);
  assert.equal(next.status, 'running');
}));
