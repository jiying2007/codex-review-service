'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRunnerCapability } = require('../src/codex');
const { normalizeReviewRequest } = require('../src/runner-server');
const {
  SAFE_CORE_VERSION,
  SAFE_CONTRACT_VERSION,
  REVIEW_RECEIPT_SCHEMA_VERSION,
  REVIEW_PROMPT_CONTRACT_VERSION
} = require('../src/codex-safe-core/safe-contract');

function capability(overrides = {}) {
  return {
    ok: true,
    version: 'codex-cli test',
    versionMatched: true,
    safeCoreVersion: SAFE_CORE_VERSION,
    safeContractVersion: SAFE_CONTRACT_VERSION,
    reviewReceiptSchemaVersion: REVIEW_RECEIPT_SCHEMA_VERSION,
    promptContractVersion: REVIEW_PROMPT_CONTRACT_VERSION,
    os: 'linux',
    arch: 'x64',
    model: 'gpt-test',
    maxConcurrency: 1,
    ...overrides
  };
}

test('Runner capability accepts exact family contract', () => {
  const result = assertRunnerCapability(capability(), { codexModel: 'gpt-test' });
  assert.equal(result.safeCoreVersion, SAFE_CORE_VERSION);
  assert.equal(result.promptContractVersion, REVIEW_PROMPT_CONTRACT_VERSION);
});

test('Runner capability rejects protocol drift', () => {
  assert.throws(() => assertRunnerCapability(capability({ safeCoreVersion: SAFE_CORE_VERSION + 1 })), /safeCoreVersion mismatch/);
  assert.throws(() => assertRunnerCapability(capability({ promptContractVersion: REVIEW_PROMPT_CONTRACT_VERSION + 1 })), /promptContractVersion mismatch/);
  assert.throws(() => assertRunnerCapability(capability({ maxConcurrency: 0 })), /maxConcurrency/);
  assert.throws(() => assertRunnerCapability(capability({ model: 'other' }), { codexModel: 'gpt-test' }), /model mismatch/);
});

test('isolated runner validates request bounds before model execution', () => {
  const config = { reviewTimeoutSeconds: 180, codexModel: 'gpt-test' };
  const valid = normalizeReviewRequest({ prompt: 'review', promptContractVersion: REVIEW_PROMPT_CONTRACT_VERSION, reviewTimeoutSeconds: 120, maxFindings: 40, model: 'gpt-test' }, config);
  assert.equal(valid.reviewTimeoutSeconds, 120);
  assert.equal(valid.maxFindings, 40);
  assert.throws(() => normalizeReviewRequest({ prompt: 'review', promptContractVersion: REVIEW_PROMPT_CONTRACT_VERSION, maxFindings: -1 }, config), error => error.code === 'ERUNNERREQUEST' && error.status === 400);
  assert.throws(() => normalizeReviewRequest({ prompt: 'review', promptContractVersion: REVIEW_PROMPT_CONTRACT_VERSION, maxFindings: '40' }, config), error => error.code === 'ERUNNERREQUEST');
  assert.throws(() => normalizeReviewRequest({ prompt: 'review', promptContractVersion: REVIEW_PROMPT_CONTRACT_VERSION, reviewTimeoutSeconds: -1 }, config), error => error.code === 'ERUNNERREQUEST');
  assert.throws(() => normalizeReviewRequest({ prompt: 'review', promptContractVersion: REVIEW_PROMPT_CONTRACT_VERSION + 1 }, config), error => error.code === 'ERUNNERCONTRACT' && error.status === 409);
});
