'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const corpus = require('../quality/cross-review-corpus.json');
const {
  DIFFERENTIAL_SCHEMA_VERSION,
  evaluateCrossReviewDifferential,
  assertCrossReviewDifferential
} = require('../src/differential-quality');

test('cross-review corpus deterministically classifies High+ disagreements', () => {
  assert.equal(corpus.schemaVersion, 1);
  assert.ok(Array.isArray(corpus.cases) && corpus.cases.length >= 6);
  const ids = new Set();
  for (const item of corpus.cases) {
    assert.ok(item.id && !ids.has(item.id), `duplicate corpus id: ${item.id}`);
    ids.add(item.id);
    const result = evaluateCrossReviewDifferential(item.left, item.right, { blockingSeverity: 'high' });
    assert.equal(result.schemaVersion, DIFFERENTIAL_SCHEMA_VERSION, item.id);
    assert.equal(result.gate, item.expected.gate, item.id);
    assert.equal(result.state, item.expected.state, item.id);
    assert.equal(result.reason, item.expected.reason, item.id);
    assert.match(result.artifactDigest, /^[0-9a-f]{64}$/, item.id);
    if (result.gate === 'fail') assert.ok(result.discrepancies.length >= 1, `${item.id} must expose the disagreement`);
    if (result.gate === 'pass') assert.equal(result.discrepancies.length, 0, `${item.id} must be aligned`);
  }
  assert.ok(ids.has('removed-authorization-old-side-recall-gap'));
  assert.ok(ids.has('controller-suppressed-high-gap'));
  assert.ok(ids.has('high-plus-anchor-aligned-after-remediation'));
});

test('strict differential gate fails closed on High+ mismatch and incomplete evidence', () => {
  const recall = corpus.cases.find(item => item.id === 'removed-authorization-old-side-recall-gap');
  const recallResult = evaluateCrossReviewDifferential(recall.left, recall.right);
  assert.throws(() => assertCrossReviewDifferential(recallResult), error => error?.code === 'ECROSSREVIEWDIFF');

  const incomplete = corpus.cases.find(item => item.id === 'incomplete-coverage-is-never-clean-alignment');
  const incompleteResult = evaluateCrossReviewDifferential(incomplete.left, incomplete.right);
  assert.throws(() => assertCrossReviewDifferential(incompleteResult), error => error?.code === 'ECROSSREVIEWINCONCLUSIVE');
  assert.doesNotThrow(() => assertCrossReviewDifferential(incompleteResult, { allowInconclusive: true }));

  const aligned = corpus.cases.find(item => item.id === 'high-plus-anchor-aligned-after-remediation');
  assert.doesNotThrow(() => assertCrossReviewDifferential(evaluateCrossReviewDifferential(aligned.left, aligned.right)));
});

test('differential matching is symmetric and anchor-based across product taxonomy differences', () => {
  const aligned = corpus.cases.find(item => item.id === 'high-plus-anchor-aligned-after-remediation');
  const forward = evaluateCrossReviewDifferential(aligned.left, aligned.right);
  const reverse = evaluateCrossReviewDifferential(aligned.right, aligned.left);
  assert.equal(forward.gate, 'pass');
  assert.equal(reverse.gate, 'pass');
  assert.equal(forward.diffFingerprint, reverse.diffFingerprint);
});
