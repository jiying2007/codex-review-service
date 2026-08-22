'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReviewService, retryable } = require('../src/service');
const { Store } = require('../src/db');

test('webhook event handling is local and does not call GitLab', () => {
  let gitlabCalls = 0;
  const enqueued = [];
  const service = new ReviewService({
    config: { gitlabProjectAllowlist: new Set([7]), maxQueueDepth: 10 },
    store: { enqueue: value => (enqueued.push(value), 1), cancelMergeRequest: () => 0 },
    gitlab: new Proxy({}, { get() { gitlabCalls += 1; return () => {}; } }),
    logger: {}
  });
  const result = service.handleEvent({
    projectAllowed: true,
    shouldReview: true,
    shouldCancel: false,
    kind: 'merge_request',
    projectId: 7,
    iid: 9,
    action: 'open',
    startSha: 's',
    headSha: 'h',
    baseSha: 'b',
    sourceBranch: 'feat'
  }, 'wid');
  assert.equal(result.status, 'queued');
  assert.equal(gitlabCalls, 0);
  assert.equal(enqueued[0].dedupeKey, 'snapshot:s:h');
});

test('retry classifier does not retry policy/output or ordinary 4xx', () => {
  assert.equal(retryable({ code: 'EPROJECTPOLICY' }), false);
  assert.equal(retryable({ code: 'EGITLABHTTP', status: 403 }), false);
  assert.equal(retryable({ code: 'EGITLABHTTP', status: 429 }), true);
  assert.equal(retryable({ code: 'EGITLABHTTP', status: 503 }), true);
});

test('processes complete snapshot and publishes blocking gate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-service-e2e-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  const statuses = [];
  const summaries = [];
  const discussions = [];
  const mr = {
    project_id: 7,
    source_project_id: 7,
    iid: 9,
    state: 'opened',
    source_branch: 'feat',
    target_branch: 'main',
    diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' }
  };
  const gitlab = {
    getMergeRequest: async () => mr,
    getProjectMember: async () => ({ access_level: 40 }),
    setCommitStatus: async (projectId, _h, state) => statuses.push({ projectId, state }),
    listMergeRequestDiffs: async () => ({
      complete: true,
      items: [{ old_path: 'a.js', new_path: 'a.js', diff: '@@ -1 +1 @@\n-old\n+new' }]
    }),
    validateMergeRequestDiffCoverage: async () => ({ complete: true, reason: 'complete' }),
    upsertSummary: async (_p, _i, body) => summaries.push(body),
    createDiscussion: async () => (discussions.push(1), { id: 'd1' }),
    getDiscussion: async () => null,
    setDiscussionResolved: async () => {}
  };
  const config = {
    gitlabProjectAllowlist: new Set([7]),
    maxQueueDepth: 10,
    manualMinAccessLevel: 30,
    maxJobAttempts: 2,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 100,
    jobTimeoutSeconds: 30,
    maxDiffBytes: 4096,
    maxReviewChunks: 2,
    maxFindings: 10,
    maxPublishedFindings: 10,
    minConfidence: 0.7,
    blockingSeverity: 'high',
    reviewTimeoutSeconds: 30,
    codexPath: 'codex',
    codexModel: '',
    codexHome: '',
    workerConcurrency: 1,
    pollIntervalMs: 10,
    autoResolveObsolete: true
  };
  const policy = {
    language: 'en',
    maxDiffBytes: 4096,
    maxReviewChunks: 2,
    maxFindings: 10,
    maxPublishedFindings: 10,
    minConfidence: 0.7,
    blockingSeverity: 'high',
    severityThreshold: 'info',
    timeoutSeconds: 30,
    extraInstructions: '',
    source: 'test',
    fingerprint: 'a'.repeat(64)
  };
  const service = new ReviewService({
    config,
    store,
    gitlab,
    logger: { info() {}, warn() {}, error() {} },
    getPolicyFn: async () => policy,
    runCodexFn: async () => ({
      version: 'test',
      parsed: {
        summary: 'found issue',
        findings: [{
          severity: 'high', category: 'correctness', file: 'a.js', side: 'new', line: 1, endLine: 1,
          title: 'Regression', description: 'The new line regresses behavior.', suggestion: 'Fix it.', confidence: 0.95
        }]
      }
    })
  });
  try {
    const id = store.enqueue({
      projectId: 7,
      mrIid: 9,
      baseSha: 'b',
      startSha: 's',
      headSha: 'h',
      sourceBranch: 'feat',
      trigger: 'open',
      dedupeKey: 'snapshot:s:h',
      maxQueueDepth: 10
    });
    const job = store.claimNext();
    assert.equal(job.id, id);
    await service.processJob(job);
    assert.equal(store.getJob(id).status, 'blocked');
    assert.deepEqual(statuses, [{ projectId: 7, state: 'running' }, { projectId: 7, state: 'failed' }]);
    assert.equal(summaries.length, 1);
    assert.equal(discussions.length, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fork merge request writes external commit status to source project', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-service-fork-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  const statusProjects = [];
  const mr = {
    project_id: 7,
    source_project_id: 99,
    iid: 9,
    state: 'opened',
    source_branch: 'fork-feature',
    target_branch: 'main',
    diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' }
  };
  const gitlab = {
    getMergeRequest: async () => mr,
    setCommitStatus: async projectId => statusProjects.push(projectId),
    listMergeRequestDiffs: async () => ({ complete: true, items: [] }),
    validateMergeRequestDiffCoverage: async () => ({ complete: true, reason: 'complete' }),
    upsertSummary: async () => {},
    getDiscussion: async () => null,
    setDiscussionResolved: async () => {}
  };
  const config = {
    gitlabProjectAllowlist: new Set([7]), maxQueueDepth: 10, manualMinAccessLevel: 30,
    maxJobAttempts: 1, retryBaseDelayMs: 10, retryMaxDelayMs: 100, jobTimeoutSeconds: 30,
    workerConcurrency: 1, pollIntervalMs: 10, autoResolveObsolete: true
  };
  const policy = {
    language: 'en', maxDiffBytes: 4096, maxReviewChunks: 2, maxFindings: 10,
    maxPublishedFindings: 10, minConfidence: 0.7, blockingSeverity: 'high',
    severityThreshold: 'info', timeoutSeconds: 30, extraInstructions: '', source: 'test', fingerprint: 'b'.repeat(64)
  };
  const service = new ReviewService({
    config,
    store,
    gitlab,
    logger: { info() {}, warn() {}, error() {} },
    getPolicyFn: async () => policy,
    runCodexFn: async () => { throw new Error('should not run without chunks'); }
  });
  try {
    store.enqueue({
      projectId: 7, mrIid: 9, baseSha: 'b', startSha: 's', headSha: 'h', sourceBranch: 'fork-feature',
      trigger: 'open', dedupeKey: 'snapshot:s:h', maxQueueDepth: 10
    });
    await service.processJob(store.claimNext());
    assert.deepEqual(statusProjects, [99, 99]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hard diff-limit mismatch makes review incomplete', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-service-diff-limit-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  const states = [];
  const mr = {
    project_id: 7, source_project_id: 7, iid: 9, state: 'opened', source_branch: 'feat', target_branch: 'main',
    diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' }
  };
  const gitlab = {
    getMergeRequest: async () => mr,
    setCommitStatus: async (_p, _h, state) => states.push(state),
    listMergeRequestDiffs: async () => ({
      complete: true,
      items: [{ old_path: 'a.js', new_path: 'a.js', diff: '@@ -1 +1 @@\n-a\n+b' }]
    }),
    validateMergeRequestDiffCoverage: async () => ({ complete: false, reason: 'diff_version_size_mismatch' }),
    upsertSummary: async () => {},
    createDiscussion: async () => ({ id: 'd1' }),
    getDiscussion: async () => null,
    setDiscussionResolved: async () => {}
  };
  const config = {
    gitlabProjectAllowlist: new Set([7]), maxQueueDepth: 10, manualMinAccessLevel: 30,
    maxJobAttempts: 1, retryBaseDelayMs: 10, retryMaxDelayMs: 100, jobTimeoutSeconds: 30,
    workerConcurrency: 1, pollIntervalMs: 10, autoResolveObsolete: true
  };
  const policy = {
    language: 'en', maxDiffBytes: 4096, maxReviewChunks: 2, maxFindings: 10,
    maxPublishedFindings: 10, minConfidence: 0.7, blockingSeverity: 'high',
    severityThreshold: 'info', timeoutSeconds: 30, extraInstructions: '', source: 'test', fingerprint: 'c'.repeat(64)
  };
  const service = new ReviewService({
    config,
    store,
    gitlab,
    logger: { info() {}, warn() {}, error() {} },
    getPolicyFn: async () => policy,
    runCodexFn: async () => ({ version: 'test', parsed: { summary: 'ok', findings: [] } })
  });
  try {
    const id = store.enqueue({
      projectId: 7, mrIid: 9, baseSha: 'b', startSha: 's', headSha: 'h', sourceBranch: 'feat',
      trigger: 'open', dedupeKey: 'snapshot:s:h', maxQueueDepth: 10
    });
    await service.processJob(store.claimNext());
    assert.equal(store.getJob(id).status, 'incomplete');
    assert.deepEqual(states, ['running', 'failed']);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
