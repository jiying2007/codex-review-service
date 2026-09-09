'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyFindingLifecycle } = require('../src/finding-ledger');

test('finding ledger classifies new persistent resolved and regressed deterministically', () => {
  const history = [
    { run_id: 20, fingerprint: 'persistent', claim_state: 'known', claim_fingerprint: 'persistent' },
    { run_id: 20, fingerprint: 'resolved', claim_state: 'known', claim_fingerprint: 'resolved' },
    { run_id: 10, fingerprint: 'persistent', claim_state: 'known', claim_fingerprint: 'persistent' },
    { run_id: 10, fingerprint: 'regressed', claim_state: 'known', claim_fingerprint: 'regressed' }
  ];
  const ledger = classifyFindingLifecycle([
    { fingerprint: 'persistent', claimState: 'known', claimFingerprint: 'persistent' },
    { fingerprint: 'regressed', claimState: 'known', claimFingerprint: 'regressed' },
    { fingerprint: 'new', claimState: 'known', claimFingerprint: 'new' }
  ], history);
  assert.equal(ledger.previousRunId, 20);
  assert.deepEqual(ledger.counts, { new: 1, persistent: 1, resolved: 1, regressed: 1, unclassified: 0 });
  assert.deepEqual(Object.fromEntries(ledger.entries.map(item => [item.fingerprint, item.state])), {
    persistent: 'persistent',
    regressed: 'regressed',
    new: 'new',
    resolved: 'resolved'
  });
});

test('finding ledger has no phantom resolutions without a prior run', () => {
  const ledger = classifyFindingLifecycle([{ fingerprint: 'a', claimState: 'known', claimFingerprint: 'a' }], []);
  assert.deepEqual(ledger.counts, { new: 1, persistent: 0, resolved: 0, regressed: 0, unclassified: 0 });
});

test('legacy and unknown identities never become resolved lifecycle claims',()=>{const ledger=classifyFindingLifecycle([{fingerprint:'new-prose',claimState:'unknown'}],[{run_id:3,fingerprint:'legacy',claim_state:'legacy',discussion_id:'d1'},{run_id:3,fingerprint:'old-prose',claim_state:'unknown',discussion_id:'d2'}]);assert.deepEqual(ledger.counts,{new:0,persistent:0,resolved:0,regressed:0,unclassified:1});assert.equal(ledger.entries.some(item=>item.state==='resolved'),false);});
