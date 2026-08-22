'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/db');
const { installFairScheduling } = require('../src/fair-scheduler');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-fair-'));
  const store = new Store(path.join(dir, 'queue.db'));
  return { store, cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function enqueue(store, projectId, mrIid, suffix) {
  return store.enqueue({ projectId, mrIid, trigger: 'test', dedupeKey: `test:${suffix}`, maxQueueDepth: 100 });
}

test('scheduler rotates across projects while preserving each project FIFO', () => {
  const { store, cleanup } = tempStore();
  try {
    installFairScheduling(store);
    enqueue(store, 1, 11, 'a1');
    enqueue(store, 1, 12, 'a2');
    enqueue(store, 1, 13, 'a3');
    enqueue(store, 2, 21, 'b1');
    enqueue(store, 3, 31, 'c1');

    const first = store.claimNext(); store.finishJob(first.id, 'pass');
    const second = store.claimNext(); store.finishJob(second.id, 'pass');
    const third = store.claimNext(); store.finishJob(third.id, 'pass');
    const fourth = store.claimNext(); store.finishJob(fourth.id, 'pass');

    assert.deepEqual([first.project_id, second.project_id, third.project_id], [1, 2, 3]);
    assert.equal(fourth.project_id, 1);
    assert.equal(first.mr_iid, 11);
    assert.equal(fourth.mr_iid, 12);
  } finally { cleanup(); }
});

test('scheduler never claims a second running job for the same MR', () => {
  const { store, cleanup } = tempStore();
  try {
    installFairScheduling(store);
    enqueue(store, 1, 11, 'old');
    enqueue(store, 1, 11, 'new');
    const first = store.claimNext();
    assert.ok(first);
    assert.equal(store.claimNext(), null);
  } finally { cleanup(); }
});
