'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ReviewService } = require('../src/service');

function finding(fingerprint, severity = 'medium') {
  return { fingerprint, severity, category: 'correctness', file: 'src/a.js', side: 'new', line: 1, endLine: 1, title: fingerprint, description: fingerprint, suggestion: '', confidence: 0.9 };
}

test('ReviewService derives and persists finding lifecycle before publication planning', () => {
  const history = [
    { fingerprint: 'persist', run_id: 5, discussion_id: 'd1' },
    { fingerprint: 'resolved', run_id: 5, discussion_id: 'd2' },
    { fingerprint: 'regressed', run_id: 4, discussion_id: 'd3' }
  ];
  const store = { priorFindings: () => history };
  const service = new ReviewService({
    config: { autoResolveObsolete: false },
    store,
    gitlab: {},
    logger: {}
  });
  const review = {
    verdict: 'needs_attention',
    summary: 'summary',
    findings: [finding('persist'), finding('regressed'), finding('new')],
    allFindings: [finding('persist'), finding('regressed'), finding('new')],
    coverageComplete: true,
    deterministicFindingCount: 0,
    deterministicViolationCount: 0,
    rejectedFindingCount: 0,
    truncatedFindingCount: 0
  };
  const snapshot = {
    projectId: 7,
    iid: 11,
    headSha: 'a'.repeat(40),
    startSha: 'b'.repeat(40),
    sourceBranch: 'feature',
    coverageGaps: [],
    advisories: [],
    files: [{ path: 'src/a.js', skipped: false, old_path: 'src/a.js', new_path: 'src/a.js' }],
    diffRefs: {}
  };
  const policy = {
    language: 'en',
    maxPublishedFindings: 10,
    source: 'target:main',
    fingerprint: 'f'.repeat(64)
  };
  const job = { id: 9, project_id: 7, mr_iid: 11, status_project_id: 7, pipeline_id: null };

  const actions = service.planPublication(job, snapshot, review, policy);
  assert.deepEqual(review.findingLifecycle.counts, { new: 1, persistent: 1, resolved: 1, regressed: 1 });
  assert.equal(review.findingLifecycle.previousRunId, 5);
  const summary = actions.find(action => action.type === 'summary');
  assert.ok(summary);
  assert.match(summary.payload.body, /Finding lifecycle:/);
  assert.match(summary.payload.body, /new 1/);
  assert.match(summary.payload.body, /persistent 1/);
  assert.match(summary.payload.body, /resolved 1/);
  assert.match(summary.payload.body, /regressed 1/);
});
