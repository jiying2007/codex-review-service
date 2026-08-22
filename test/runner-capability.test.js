'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRunnerCapability } = require('../src/codex');
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
