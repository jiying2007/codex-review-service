'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, SCHEMA_VERSION } = require('../src/db');
const { createServiceReviewReceipt } = require('../src/review');
const {
  SAFE_CORE_VERSION,
  SAFE_CONTRACT_VERSION,
  REVIEW_RECEIPT_SCHEMA_VERSION,
  REVIEW_PROMPT_CONTRACT_VERSION,
  validateReviewReceipt
} = require('../src/codex-safe-core/safe-contract');
const { POLICY_SCHEMA_VERSION } = require('../src/codex-safe-core/policy');

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-receipt-v5-'));
  const store = new Store(path.join(dir, 'test.sqlite'));
  try { return fn(store); }
  finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
function identityReview(review={}) {
  return {
    reviewSubjectFingerprint: '5'.repeat(64),
    evidenceManifestDigest: '6'.repeat(64),
    ...review
  };
}

test('schema 7 contains canonical Review Receipt v5 projection columns', () => withStore(store => {
  assert.equal(SCHEMA_VERSION, 7);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  const columns = new Set(store.db.prepare('PRAGMA table_info(review_runs)').all().map(row => row.name));
  assert.ok(columns.has('receipt_json'));
  assert.ok(columns.has('receipt_fingerprint'));
}));

test('GitLab MR Review Receipt v5 binds judgment and evidence identity and stores atomically', () => withStore(store => {
  const startSha = '1'.repeat(40), headSha = '2'.repeat(40);
  const snapshot = { projectId: 7, iid: 11, startSha, headSha, diffFingerprint: '3'.repeat(64) };
  const policy = { source: 'target:main', fingerprint: '4'.repeat(64) };
  const review = identityReview({
    verdict: 'needs_attention', summary: 'review', coverageComplete: true,
    findings: [], allFindings: [], codexVersion: 'codex-cli 9.9.9', codexModel: 'gpt-test',
    chunkCount: 1, rejectedFindingCount: 0, truncatedFindingCount: 0,
    deterministicViolationCount: 0, usage: { inputTokens: 10, outputTokens: 2 }
  });
  const projection = createServiceReviewReceipt(snapshot, review, policy, new Date('2026-08-22T00:00:00.000Z'));
  assert.ok(validateReviewReceipt(projection.receipt));
  assert.equal(projection.receipt.schemaVersion, REVIEW_RECEIPT_SCHEMA_VERSION);
  assert.equal(projection.receipt.schemaVersion, 5);
  assert.equal(projection.receipt.safeCoreVersion, SAFE_CORE_VERSION);
  assert.equal(projection.receipt.safeContractVersion, SAFE_CONTRACT_VERSION);
  assert.equal(projection.receipt.policySchemaVersion, POLICY_SCHEMA_VERSION);
  assert.equal(projection.receipt.promptContractVersion, REVIEW_PROMPT_CONTRACT_VERSION);
  assert.equal(projection.receipt.kind, 'codex-review');
  assert.deepEqual(projection.receipt.subject, { type: 'gitlab-mr', projectId: 7, mrIid: 11, startSha, headSha });
  assert.equal(projection.receipt.reviewSubjectFingerprint, review.reviewSubjectFingerprint);
  assert.equal(projection.receipt.evidenceManifestDigest, review.evidenceManifestDigest);
  assert.equal(projection.receipt.coverageVerdict, 'complete');
  assert.equal(validateReviewReceipt({ ...projection.receipt, schemaVersion: 4 }), null, 'Receipt v4 must remain invalid after hard cut');

  const jobId = store.enqueue({ projectId: 7, mrIid: 11, startSha, headSha, trigger: 'open', dedupeKey: 'event:receipt-v5', maxQueueDepth: 10 });
  const runId = store.saveRunWithOutbox(jobId, review, 5, policy, [
    { projectId: 7, mrIid: 11, type: 'summary', dedupeKey: 'v5:summary', payload: { headSha } }
  ], projection);
  const stored = store.receiptForRun(runId);
  assert.deepEqual(stored.receipt, projection.receipt);
  assert.equal(stored.fingerprint, projection.fingerprint);
  assert.equal(store.db.prepare('SELECT COUNT(*) count FROM publication_outbox WHERE run_id=?').get(runId).count, 1);
}));

test('incomplete Service review produces blocked Receipt v5 provenance', () => {
  const projection = createServiceReviewReceipt({
    projectId: 7, iid: 12, startSha: 'a'.repeat(40), headSha: 'b'.repeat(40), diffFingerprint: 'c'.repeat(64)
  }, identityReview({
    verdict: 'incomplete', coverageComplete: false, findings: [], allFindings: [], deterministicViolationCount: 0,
    codexVersion: 'codex-cli 9.9.9', codexModel: 'gpt-test'
  }), { fingerprint: 'd'.repeat(64) }, new Date('2026-08-22T00:00:00.000Z'));
  assert.equal(projection.receipt.schemaVersion, 5);
  assert.equal(projection.receipt.qualityVerdict, 'no_findings');
  assert.equal(projection.receipt.readinessVerdict, 'blocked');
  assert.equal(projection.receipt.coverageVerdict, 'incomplete');
});
