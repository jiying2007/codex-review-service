'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyFindingLifecycle } = require('../src/finding-ledger');

test('finding ledger classifies new persistent resolved and regressed deterministically', () => {
  const history = [
    { run_id: 20, fingerprint: 'persistent' },
    { run_id: 20, fingerprint: 'resolved' },
    { run_id: 10, fingerprint: 'persistent' },
    { run_id: 10, fingerprint: 'regressed' }
  ];
  const ledger = classifyFindingLifecycle([
    { fingerprint: 'persistent' },
    { fingerprint: 'regressed' },
    { fingerprint: 'new' }
  ], history);
  assert.equal(ledger.previousRunId, 20);
  assert.deepEqual(ledger.counts, { new: 1, persistent: 1, resolved: 1, regressed: 1 });
  assert.deepEqual(Object.fromEntries(ledger.entries.map(item => [item.fingerprint, item.state])), {
    persistent: 'persistent',
    regressed: 'regressed',
    new: 'new',
    resolved: 'resolved'
  });
});

test('finding ledger has no phantom resolutions without a prior run', () => {
  const ledger = classifyFindingLifecycle([{ fingerprint: 'a' }], []);
  assert.deepEqual(ledger.counts, { new: 1, persistent: 0, resolved: 0, regressed: 0 });
});
