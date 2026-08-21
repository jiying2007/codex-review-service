'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCodexArgs, filteredEnv, SAFE_CONFIG_OVERRIDES } = require('../src/codex');

test('Codex args preserve the Safe Contract boundary', () => {
  const args = buildCodexArgs('/tmp/schema.json', 'model-x');
  assert.deepEqual(args.slice(0, 3), ['--ask-for-approval', 'never', 'exec']);
  for (const flag of ['--json','--ephemeral','--skip-git-repo-check','--ignore-user-config','--ignore-rules','--sandbox','--output-schema','--config']) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  for (const override of SAFE_CONFIG_OVERRIDES) assert.ok(args.includes(override));
  assert.equal(args.at(-1), '-');
});

test('Codex child environment excludes GitLab service secrets', () => {
  const saved = {
    token: process.env.GITLAB_API_TOKEN,
    secret: process.env.GITLAB_WEBHOOK_SECRET_TOKEN,
    signing: process.env.GITLAB_WEBHOOK_SIGNING_TOKEN
  };
  process.env.GITLAB_API_TOKEN = 'gitlab-token';
  process.env.GITLAB_WEBHOOK_SECRET_TOKEN = 'hook-secret';
  process.env.GITLAB_WEBHOOK_SIGNING_TOKEN = 'whsec_secret';
  try {
    const env = filteredEnv({ codexHome: '/tmp/codex-home' });
    assert.equal(env.GITLAB_API_TOKEN, undefined);
    assert.equal(env.GITLAB_WEBHOOK_SECRET_TOKEN, undefined);
    assert.equal(env.GITLAB_WEBHOOK_SIGNING_TOKEN, undefined);
    assert.equal(env.CODEX_HOME, '/tmp/codex-home');
  } finally {
    if (saved.token === undefined) delete process.env.GITLAB_API_TOKEN; else process.env.GITLAB_API_TOKEN = saved.token;
    if (saved.secret === undefined) delete process.env.GITLAB_WEBHOOK_SECRET_TOKEN; else process.env.GITLAB_WEBHOOK_SECRET_TOKEN = saved.secret;
    if (saved.signing === undefined) delete process.env.GITLAB_WEBHOOK_SIGNING_TOKEN; else process.env.GITLAB_WEBHOOK_SIGNING_TOKEN = saved.signing;
  }
});
