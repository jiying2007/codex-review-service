'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Publisher, retryablePublication } = require('../src/publication');
const { findingBody } = require('../src/gitlab');

function scenario({ loseResponse = false, unknown = false, complete = true } = {}) {
  const refs = { base_sha: 'b', start_sha: 's', head_sha: 'h' };
  const finding = {
    fingerprint: 'c'.repeat(64), claimFingerprint: unknown ? '' : 'c'.repeat(64),
    claimState: unknown ? 'unknown' : 'known', anchorFingerprint: 'a'.repeat(64),
    rootCauseKey: 'state_transition_regression', claimClass: 'state_machine_correctness',
    severity: 'medium', category: 'test', file: 'a.js', side: 'new', line: 1, endLine: 1,
    title: 'Finding', description: 'Exact claim', suggestion: '', confidence: 1
  };
  const item = { id: 1, run_id: 1, action_type: 'finding', attempt: 1,
    project_id: 7, mr_iid: 9, payload: { finding, diffRefs: refs, headSha: 'h', startSha: 's', oldPath: 'a.js', newPath: 'a.js' } };
  const remote = [];
  const counts = { scans: 0, creates: 0, updates: 0, retries: 0, failures: 0 };
  let lose = loseResponse;
  const gitlab = {
    getMergeRequest: async () => ({ state: 'opened', diff_refs: refs }),
    listDiscussions: async () => { counts.scans++; return { complete, items: structuredClone(remote) }; },
    createDiscussion: async (_project,_iid,_finding,_refs,_old,_new,{beforeSend}={}) => {
      beforeSend?.();
      counts.creates++;
      const discussion = { id: String(counts.creates), notes: [{ id: counts.creates, resolvable: true, resolved: false,
        author: { username: 'bot' }, position: refs, body: findingBody(finding) }] };
      remote.push(discussion);
      if (lose) { lose = false; throw Object.assign(new Error('response lost after remote commit'), { code: 'EGITLABNETWORK' }); }
      return structuredClone(discussion);
    },
    updateFindingNote: async () => { counts.updates++; }
  };
  let writeStarted=false;
  const store = {
    findingWriteStarted:()=>writeStarted,
    markFindingWriteStarted:()=>{writeStarted=true;},
    claimProjection: () => null,
    settleFindingPublication: value => { if (value.publicationStatus === 'failed') counts.failures++; },
    retryPublication: () => { counts.retries++; }
  };
  const config = { botUsername: 'bot', maxPublishAttempts: 3, retryBaseDelayMs: 1, retryMaxDelayMs: 5 };
  const publisher = new Publisher({ config, store, gitlab, logger: { warn() {} } });
  return { publisher, item, remote, counts, gitlab, store, config };
}

test('lost create response triggers a fresh remote scan before retry', async () => {
  const s = scenario({ loseResponse: true });
  await assert.rejects(s.publisher.publishFinding(s.item), error => error.code === 'EGITLABNETWORK');
  assert.equal(s.remote.length, 1);
  const result = await s.publisher.publishFinding({ ...s.item, attempt: 2 });
  assert.equal(result.remoteId, '1');
  assert.equal(s.counts.scans, 2);
  assert.equal(s.counts.creates, 1);
  assert.equal(s.publisher.discussionScans.size, 0);
  assert.equal(s.publisher.findingPublications.size, 0);
});

test('local settlement failure after remote success does not duplicate the remote note', async () => {
  const s = scenario();
  let attempts = 0;
  s.store.settleFindingPublication = () => { if (++attempts === 1) throw new Error('local settlement interrupted'); };
  await s.publisher.process(s.item);
  await s.publisher.process({ ...s.item, attempt: 2 });
  assert.equal(s.counts.retries, 1);
  assert.equal(s.counts.creates, 1);
  assert.equal(attempts, 2);
});

test('restart without an in-memory projection recovers the already created discussion', async () => {
  const s = scenario({ loseResponse: true });
  await assert.rejects(s.publisher.publishFinding(s.item));
  const restarted = new Publisher({ config: s.config, store: s.store, gitlab: s.gitlab, logger: {} });
  assert.equal((await restarted.publishFinding(s.item)).remoteId, '1');
  assert.equal(s.counts.creates, 1);
});

test('concurrent same-MR known-claim publication is serialized and reconciled', async () => {
  const s = scenario();
  const results = await Promise.all([s.publisher.publishFinding(s.item), s.publisher.publishFinding({ ...s.item, id: 2 })]);
  assert.deepEqual(results.map(result => result.remoteId), ['1', '1']);
  assert.equal(s.counts.creates, 1);
  assert.equal(s.publisher.findingPublications.size, 0);
});

test('incomplete pagination never authorizes creating another discussion', async () => {
  const s = scenario({ complete: false });
  await assert.rejects(s.publisher.publishFinding(s.item), error => error.code === 'EGITLABPAGINATION');
  assert.equal(s.counts.creates, 0);
  assert.equal(s.publisher.discussionScans.size, 0);
});

test('unknown-claim uncertain write stops automatic retries without semantic reuse', async () => {
  const s = scenario({ loseResponse: true, unknown: true });
  await s.publisher.process(s.item);
  assert.equal(s.counts.scans, 0);
  assert.equal(s.counts.creates, 1);
  assert.equal(s.counts.retries, 0);
  assert.equal(s.counts.failures, 1);
  assert.equal(retryablePublication({ code: 'ECLAIMPUBLISHUNCERTAIN' }), false);
});

test('HEAD drift during discussion scan blocks the subsequent write', async () => {
  const s = scenario();
  let snapshots = 0;
  s.gitlab.getMergeRequest = async () => ({ state: 'opened', diff_refs: { start_sha: 's', head_sha: ++snapshots === 1 ? 'h' : 'changed' } });
  const result = await s.publisher.publishFinding(s.item);
  assert.equal(result.cancelled, true);
  assert.equal(s.counts.creates, 0);
});
