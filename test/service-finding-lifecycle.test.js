'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ReviewService } = require('../src/service');

function finding(fingerprint, severity = 'medium') {
  return { fingerprint, claimState:'known', claimFingerprint:fingerprint, severity, category: 'correctness', file: 'src/a.js', side: 'new', line: 1, endLine: 1, title: fingerprint, description: fingerprint, suggestion: '', confidence: 0.9 };
}

test('ReviewService derives and persists finding lifecycle before publication planning', () => {
  const history = [
    { fingerprint: 'persist', claim_state:'known', claim_fingerprint:'persist', run_id: 5, discussion_id: 'd1' },
    { fingerprint: 'resolved', claim_state:'known', claim_fingerprint:'resolved', run_id: 5, discussion_id: 'd2' },
    { fingerprint: 'regressed', claim_state:'known', claim_fingerprint:'regressed', run_id: 4, discussion_id: 'd3' }
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
  assert.deepEqual(review.findingLifecycle.counts, { new: 1, persistent: 1, resolved: 1, regressed: 1, unclassified: 0 });
  assert.equal(review.findingLifecycle.previousRunId, 5);
  const summary = actions.find(action => action.type === 'summary');
  assert.ok(summary);
  assert.match(summary.payload.body, /Finding lifecycle:/);
  assert.match(summary.payload.body, /new 1/);
  assert.match(summary.payload.body, /persistent 1/);
  assert.match(summary.payload.body, /resolved 1/);
  assert.match(summary.payload.body, /regressed 1/);
});

test('publication planning resolves only known claims after a complete review',()=>{const known={fingerprint:'known',claim_state:'known',claim_fingerprint:'known',discussion_id:'d1',run_id:5},legacy={fingerprint:'legacy',claim_state:'legacy',claim_fingerprint:'',discussion_id:'d2',run_id:5},store={priorFindings:()=>[known,legacy]},service=new ReviewService({config:{autoResolveObsolete:true},store,gitlab:{},logger:{}}),snapshot={headSha:'a'.repeat(40),startSha:'b'.repeat(40),sourceBranch:'feature',coverageGaps:[],advisories:[],files:[],diffRefs:{}},review={verdict:'pass',summary:'ok',findings:[],coverageComplete:true},policy={language:'en',maxPublishedFindings:10,source:'x',fingerprint:'f'.repeat(64)},job={id:1,project_id:7,mr_iid:9,status_project_id:7};const complete=service.planPublication(job,snapshot,review,policy).filter(action=>action.type==='resolve');assert.equal(complete.length,1);assert.equal(complete[0].payload.discussionId,'d1');assert.equal(complete[0].payload.finding.claimState,'known');const incomplete=service.planPublication(job,snapshot,{...review,coverageComplete:false,verdict:'incomplete'},policy).filter(action=>action.type==='resolve');assert.equal(incomplete.length,0);});
