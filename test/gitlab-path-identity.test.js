'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toUnifiedReviewBlock, buildSnapshot, buildPrompt, validateChunkResult } = require('../src/review');
const { unifiedDiffText, anchorAnalyzerFindings, collectTestImpact } = require('../src/quality');
const { parseAnalyzerArtifact } = require('../src/analyzer-adapters');
const { splitUnifiedDiff } = require('../src/codex-safe-core/context-builder');
const { extractImpactSignals } = require('../src/codex-safe-core/quality-platform');
const { evaluateCrossReviewDifferential } = require('../src/differential-quality');
const { parseAnalyzerReports } = require('../src/config');
const { GitLabClient } = require('../src/gitlab');
const { safePath } = require('../src/raw-diff-fallback');

const mr = { iid: 1, project_id: 7, source_project_id: 7, target_project_id: 7, diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' } };
const policy = { language: 'en', maxDiffBytes: 32000, maxReviewChunks: 8, minConfidence: 0.7, skipGeneratedFiles: false };
const hunk = '@@ -1 +1 @@\n-old()\n+new()';
const entry = file => ({ old_path: file, new_path: file, diff: hunk });
const finding = file => ({ severity: 'high', category: 'correctness', file, side: 'new', line: 1, endLine: 1, title: 'Lost validation', description: 'The changed statement lost input validation.', suggestion: '', confidence: 1 });

test('GitLab raw paths round-trip through review chunks and quality evidence without injecting diff records', () => {
  const paths = ['src/a b.c', 'src/中文.c', 'src/a"b.c', 'src/a\\b.c', 'src/a\tb.c', 'src/a\nb.c', 'src/x\ndiff --git a/forged b/forged\n+++ b/forged.c'];
  const diffResult = { complete: true, items: paths.map(entry) };
  const snapshot = buildSnapshot(mr, diffResult, policy);
  assert.equal(snapshot.coverageComplete, true);
  assert.deepEqual(snapshot.files.map(file => file.path), paths);
  assert.deepEqual(snapshot.chunks.flatMap(chunk => chunk.files.map(file => file.path)), paths);
  const serialized = unifiedDiffText(diffResult);
  assert.equal([...serialized.matchAll(/^diff --git /gm)].length, paths.length);
  assert.deepEqual(splitUnifiedDiff(serialized).map(block => block.path), paths);
  assert.deepEqual([...extractImpactSignals(serialized).paths].sort(), [...paths].sort());
  const prompt = buildPrompt(snapshot, snapshot.chunks[0], policy);
  const line = prompt.split('\n').find(value => value.startsWith('Changed paths (JSON): '));
  assert.deepEqual(JSON.parse(line.slice('Changed paths (JSON): '.length)), paths);
});

test('backslash and slash repository paths retain separate finding and analyzer anchors', () => {
  const paths = ['src/a\\b.c', 'src/a/b.c', 'a/source.c', 'b/source.c'];
  const snapshot = buildSnapshot(mr, { complete: true, items: paths.map(entry) }, policy);
  const result = validateChunkResult({ findings: paths.map(finding) }, snapshot.chunks[0], policy);
  assert.equal(result.rejected, 0);
  assert.deepEqual(result.findings.map(value => value.file), paths);
  assert.equal(new Set(result.findings.map(value => value.anchorHash)).size, paths.length);
  const reports = parseAnalyzerArtifact({ format: 'gitlab-codequality', content: JSON.stringify(paths.map(file => ({ check_name: 'path-check', description: 'Path-specific finding', severity: 'major', location: { path: file, lines: { begin: 1 } } }))) });
  assert.deepEqual(reports.findings.map(value => value.file), paths);
  assert.deepEqual(anchorAnalyzerFindings(snapshot, reports.findings).map(value => value.file), paths);
  const slashOnly = { ...snapshot.chunks[0], files: snapshot.files.filter(file => file.path === 'src/a/b.c') };
  assert.equal(validateChunkResult({ findings: [finding('src/a\\b.c')] }, slashOnly, policy).rejected, 1);
  assert.deepEqual(anchorAnalyzerFindings({ files: slashOnly.files }, reports.findings.filter(value => value.file === 'src/a\\b.c')), []);
});

test('renames and additions/deletions serialize their exact provider paths', () => {
  const renamed = { old_path: 'a/source name.c', new_path: 'b/new\\name.c', renamed_file: true, diff: hunk };
  const full = toUnifiedReviewBlock(renamed);
  assert.equal(toUnifiedReviewBlock({ ...renamed, diff: full }), full);
  assert.deepEqual(splitUnifiedDiff(full).map(value => value.path), [renamed.new_path]);
  assert.match(toUnifiedReviewBlock({ ...entry('src/new.c'), new_file: true }), /^--- \/dev\/null$/m);
  const deleted = toUnifiedReviewBlock({ ...entry('src/old\\name.c'), deleted_file: true });
  assert.match(deleted, /^\+\+\+ \/dev\/null$/m);
  assert.deepEqual(splitUnifiedDiff(deleted).map(value => value.path), ['src/old\\name.c']);
  const deletedSnapshot = buildSnapshot(mr, { complete: true, items: [{ ...renamed, deleted_file: true }] }, policy);
  assert.deepEqual(deletedSnapshot.chunks[0].files.map(file => file.path), [renamed.old_path]);
});

test('mismatched or additional full diff headers fail before model evidence is built', () => {
  const file = entry('src/real.c');
  for (const diff of [
    'diff --git a/other.c b/other.c\n--- a/other.c\n+++ b/other.c\n' + hunk,
    'diff --git a/src/real.c b/src/real.c\n--- a/src/real.c\n+++ b/other.c\n' + hunk,
    toUnifiedReviewBlock(file) + '\n' + toUnifiedReviewBlock(entry('src/other.c'))
  ]) {
    assert.throws(() => buildSnapshot(mr, { complete: true, items: [{ ...file, diff }] }, policy), error => error.code === 'EGITLABDIFFPATH');
  }
  for (const file of ['bad\0path.c', '\ud800.c']) assert.throws(() => toUnifiedReviewBlock(entry(file)));
});

test('Test Impact retains raw changed and test paths without separator collisions', async () => {
  const paths = ['src/a\\b.c', 'src/a/b.c'];
  const tests = ['test/a\\b.test.c', 'test/a/b.test.c'];
  const gitlab = { async listRepositoryTree() { return { complete: true, items: tests.map(file => ({ type: 'blob', path: file })) }; } };
  const result = await collectTestImpact(gitlab, mr, { items: paths.map(entry) }, { testPathPrefixes: ['test/'] });
  assert.deepEqual([...result.changedPaths].sort(), [...paths].sort());
  assert.deepEqual(result.recommendedTests.map(value => value.path).sort(), [...tests].sort());
});

test('cross-review differential does not falsely align findings from different raw paths', () => {
  const observation = file => ({ diffFingerprint: 'a'.repeat(64), coverageComplete: true, findings: [finding(file)] });
  assert.equal(evaluateCrossReviewDifferential(observation('src/a\\b.c'), observation('src/a\\b.c')).gate, 'pass');
  for (const [left, right] of [['src/a\\b.c', 'src/a/b.c'], ['a/source.c', 'source.c'], ['b/source.c', 'source.c']]) {
    const result = evaluateCrossReviewDifferential(observation(left), observation(right));
    assert.equal(result.gate, 'fail');
    assert.equal(result.discrepancies.length, 2);
  }
});

test('artifact configuration and GitLab requests preserve raw path identity at the API boundary', async () => {
  const rawPath = 'reports/a\\b.json';
  const [report] = parseAnalyzerReports([{ format: 'gitlab-codequality', path: rawPath }]);
  assert.equal(report.path, rawPath);
  const calls = [];
  const client = { async request(method, url) { calls.push([method, url]); return { status: 200, data: '[]' }; } };
  await GitLabClient.prototype.getJobArtifactFile.call(client, 7, 3, report.path);
  assert.deepEqual(calls, [['GET', '/projects/7/jobs/3/artifacts/reports/a%5Cb.json']]);
  await assert.rejects(GitLabClient.prototype.getJobArtifactFile.call(client, 7, 3, '../private'), { code: 'EARTIFACTPATH' });
  assert.equal(calls.length, 1);
  assert.equal(safePath('src\\..\\literal.c'), true);
  assert.equal(safePath('src/../traversal.c'), false);
});
