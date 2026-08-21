'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSnapshot, validateReview, parseChangedLineRanges } = require('../src/review');

const config = { maxFindings: 40, minConfidence: 0.7 };

test('parses changed lines from unified diff', () => {
  const diff = '@@ -10,2 +10,3 @@\n old\n+new one\n same\n+new two';
  assert.deepEqual(parseChangedLineRanges(diff), [11, 13]);
});

test('marks coverage incomplete for too-large or budget-skipped diffs', () => {
  const mr = { iid: 1, diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' } };
  const snapshot = buildSnapshot(mr, [
    { old_path: 'a.js', new_path: 'a.js', diff: '@@ -1 +1 @@\n-a\n+b', too_large: false },
    { old_path: 'b.js', new_path: 'b.js', diff: '', too_large: true }
  ], 1024);
  assert.equal(snapshot.coverageComplete, false);
  assert.equal(snapshot.files.filter(f => f.skipped).length, 1);
});

test('validates findings against changed paths and lines', () => {
  const mr = { iid: 1, diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' } };
  const snapshot = buildSnapshot(mr, [
    { old_path: 'a.js', new_path: 'a.js', diff: '@@ -10 +10,2 @@\n old\n+const x = risky();', too_large: false }
  ], 4096);
  const review = validateReview({
    summary: 'summary',
    findings: [{
      severity: 'high', category: 'correctness', file: 'a.js', line: 11, endLine: 11,
      title: 'Unchecked failure', description: 'The new call can fail.', suggestion: 'Handle the failure.', confidence: 0.9
    }, {
      severity: 'high', category: 'correctness', file: 'not-changed.js', line: 1, endLine: 1,
      title: 'Invalid path', description: 'Should be rejected.', suggestion: '', confidence: 0.9
    }]
  }, snapshot, config);
  assert.equal(review.findings.length, 1);
  assert.equal(review.verdict, 'block');
});
