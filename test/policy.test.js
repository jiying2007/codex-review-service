'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { POLICY_FILE, getEffectivePolicy } = require('../src/policy');

const config = {
  projectPolicyMaxBytes: 65536,
  projectPolicyEnabled: true,
  language: 'zh-CN',
  maxDiffBytes: 1024 * 1024,
  maxFindings: 40,
  reviewTimeoutSeconds: 180,
  blockingSeverity: 'high',
  maxReviewChunks: 8,
  maxPublishedFindings: 40,
  minConfidence: 0.7,
  skipGeneratedFiles: true,
  blockUnreviewableFiles: false,
  maxContextBytes: 256 * 1024,
  maxContextFiles: 12,
  contextLines: 20
};
const mr = { target_branch: 'main', diff_refs: { start_sha: 'a'.repeat(40) } };

function gitlabWith(document, seen = {}) {
  return {
    async getRepositoryFileRaw(projectId, file, ref) {
      Object.assign(seen, { projectId, file, ref });
      return document === null ? null : JSON.stringify(document);
    }
  };
}

test('target Policy v4 cannot hide globally blocking findings', async () => {
  await assert.rejects(
    () => getEffectivePolicy(gitlabWith({ schemaVersion: 4, review: { severityThreshold: 'critical' } }), 1, mr, config),
    /cannot hide/
  );
  const effective = await getEffectivePolicy(gitlabWith({ schemaVersion: 4, review: { severityThreshold: 'medium' } }), 1, mr, config);
  assert.equal(effective.severityThreshold, 'medium');
});

test('effective Policy v4 is pinned to target start SHA and globally capped', async () => {
  const seen = {};
  const policy = await getEffectivePolicy(gitlabWith({
    schemaVersion: 4,
    review: {
      language: 'en',
      maxDiffBytes: 2 * 1024 * 1024,
      maxFindings: 80,
      timeoutSeconds: 300,
      confidenceThreshold: 0.8,
      rules: {
        requireTestsForCodeChanges: true,
        codePathPrefixes: ['src/'],
        testPathPrefixes: ['test/'],
        forbiddenPathPrefixes: ['secrets/']
      }
    },
    reviewService: {
      maxContextBytes: 512 * 1024,
      maxContextFiles: 30,
      contextLines: 50,
      skipGeneratedFiles: false,
      blockUnreviewableFiles: true
    }
  }, seen), 1, mr, config);
  assert.equal(seen.ref, mr.diff_refs.start_sha);
  assert.equal(seen.file, POLICY_FILE);
  assert.equal(POLICY_FILE, '.codex-safe.json');
  assert.equal(policy.language, 'en');
  assert.equal(policy.maxDiffBytes, config.maxDiffBytes);
  assert.equal(policy.maxFindings, config.maxFindings);
  assert.equal(policy.timeoutSeconds, config.reviewTimeoutSeconds);
  assert.equal(policy.minConfidence, 0.8);
  assert.equal(policy.maxContextBytes, config.maxContextBytes);
  assert.equal(policy.maxContextFiles, config.maxContextFiles);
  assert.equal(policy.contextLines, config.contextLines);
  assert.equal(policy.skipGeneratedFiles, false);
  assert.equal(policy.blockUnreviewableFiles, true);
  assert.equal(policy.reviewRules.requireTestsForCodeChanges, true);
  assert.match(policy.source, /^target:\.codex-safe\.json@/);
  assert.match(policy.fingerprint, /^[0-9a-f]{64}$/);
});

test('Policy v2 is rejected with no compatibility parser', async () => {
  await assert.rejects(
    () => getEffectivePolicy(gitlabWith({ schemaVersion: 2, review: { language: 'en' } }), 1, mr, config),
    /Policy Schema v4/
  );
});
