'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSnapshot,
  validateChunkResult,
  consolidateReviews,
  parseChangedLines
} = require('../src/review');

const policy = {
  language: 'en',
  maxDiffBytes: 100,
  maxReviewChunks: 2,
  maxFindings: 10,
  maxPublishedFindings: 10,
  minConfidence: 0.7,
  severityThreshold: 'info',
  blockingSeverity: 'high',
  extraInstructions: ''
};
const mr = {
  iid: 1,
  source_branch: 'feat',
  target_branch: 'main',
  diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' }
};

test('tracks added and removed changed lines', () => {
  assert.deepEqual(parseChangedLines('@@ -10,2 +10,2 @@\n-old\n+new\n same'), { new: [10], old: [10] });
});

test('chunks files and fails closed on unavailable diffs', () => {
  const snapshot = buildSnapshot(mr, {
    complete: true,
    items: [
      { old_path: 'a.js', new_path: 'a.js', diff: '@@ -1 +1 @@\n-a\n+b' },
      { old_path: 'b.bin', new_path: 'b.bin', diff: '' }
    ]
  }, policy);
  assert.equal(snapshot.chunks.length, 1);
  assert.equal(snapshot.coverageComplete, false);
  assert.equal(snapshot.files.find(file => file.path === 'b.bin').skippedReason, 'unavailable_or_binary');
});

test('validates old-side findings and rejects unsupported locations', () => {
  const snapshot = buildSnapshot(mr, {
    complete: true,
    items: [{ old_path: 'a.js', new_path: 'a.js', diff: '@@ -10 +10 @@\n-danger()\n+safe()' }]
  }, { ...policy, maxDiffBytes: 4096 });
  const result = validateChunkResult({
    summary: 's',
    findings: [{
      severity: 'high', category: 'correctness', file: 'a.js', side: 'old', line: 10, endLine: 10,
      title: 'Removed guard', description: 'A guard was removed.', suggestion: 'Restore it.', confidence: 0.9
    }, {
      severity: 'low', category: 'other', file: 'missing.js', side: 'new', line: 1, endLine: 1,
      title: 'Bad path', description: 'x', suggestion: '', confidence: 0.9
    }]
  }, snapshot.chunks[0], policy);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].side, 'old');
  assert.equal(result.rejected, 1);
});

test('structurally rejected model finding makes review incomplete', () => {
  const snapshot = buildSnapshot(mr, {
    complete: true,
    items: [{ old_path: 'a.js', new_path: 'a.js', diff: '@@ -1 +1 @@\n-a\n+b' }]
  }, { ...policy, maxDiffBytes: 4096 });
  assert.equal(consolidateReviews(snapshot, [{
    summary: 's', findings: [], rejected: 1, filtered: 0, modelFindingCount: 1
  }], policy).verdict, 'incomplete');
});

test('MAX_FINDINGS is a global retained-output cap across chunks without weakening blocking gate', () => {
  const snapshot = { coverageComplete: true };
  const findings = Array.from({ length: 6 }, (_, index) => ({
    severity: index === 5 ? 'high' : 'low',
    category: 'correctness',
    file: `f${index}.js`,
    side: 'new',
    line: 1,
    endLine: 1,
    title: `Issue ${index}`,
    description: 'x',
    suggestion: '',
    confidence: 0.9,
    fingerprint: `fp-${index}`
  }));
  const result = consolidateReviews(snapshot, [
    { summary: 'a', findings: findings.slice(0, 3), rejected: 0, filtered: 0, modelFindingCount: 3 },
    { summary: 'b', findings: findings.slice(3), rejected: 0, filtered: 0, modelFindingCount: 3 }
  ], { ...policy, maxFindings: 3 });
  assert.equal(result.allFindings.length, 3);
  assert.equal(result.truncatedFindingCount, 3);
  assert.equal(result.verdict, 'block');
});
