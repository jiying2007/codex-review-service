'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const core = require('../src/codex-safe-core');
const { SCHEMA_VERSION } = require('../src/db');

const root = path.resolve(__dirname, '..');
const expectedCore = 'e6e25b502aa35a079f660346785cf283fe293b6d';
const pkg = require('../package.json');

assert.equal(pkg.version, '3.0.0');
assert.equal(core.SAFE_CORE_VERSION, 3);
assert.equal(core.SAFE_CONTRACT_VERSION, 2);
assert.equal(core.POLICY_SCHEMA_VERSION, 3);
assert.equal(core.REVIEW_RECEIPT_SCHEMA_VERSION, 3);
assert.equal(core.COMMIT_RECEIPT_SCHEMA_VERSION, 3);
assert.equal(SCHEMA_VERSION, 4);

const staged = execFileSync('git', ['ls-files', '--stage', 'src/codex-safe-core'], { cwd: root, encoding: 'utf8' }).trim();
assert.match(staged, new RegExp(`^160000 ${expectedCore} 0\\tsrc/codex-safe-core$`), 'Service must pin final Core 3.0.1 commit');

assert.equal(fs.existsSync(path.join(root, '.codex-review.example.json')), false, 'legacy service-only policy example must not exist');
const example = JSON.parse(fs.readFileSync(path.join(root, '.codex-safe.example.json'), 'utf8'));
assert.equal(example.schemaVersion, 3);
assert.ok(example.review && example.reviewService);
assert.match(String(example.$schema || ''), new RegExp(expectedCore));

const requiredPackageFiles = [
  '.codex-safe.example.json', '.env.example', 'CHANGELOG.md', 'LICENSE', 'LONG_TERM_ASSET.md',
  'OPERATIONS.md', 'README.md', 'README.zh-CN.md', 'SECURITY.md', 'config.example.json',
  'deploy/systemd/*.service', 'deploy/systemd/*.env.example', 'docs/ARCHITECTURE.md', 'src/*.js',
  'src/codex-safe-core/index.js', 'src/codex-safe-core/safe-contract.js', 'src/codex-safe-core/codex-cli.js',
  'src/codex-safe-core/process-runner.js', 'src/codex-safe-core/context-builder.js', 'src/codex-safe-core/policy.js',
  'src/codex-safe-core/review-rules.js', 'src/codex-safe-core/git-repository.js',
  'src/codex-safe-core/codex-safe.schema.json', 'src/codex-safe-core/CHANGELOG.md',
  'src/codex-safe-core/LICENSE', 'src/codex-safe-core/README.md', 'src/codex-safe-core/README.zh-CN.md',
  'src/codex-safe-core/SECURITY.md'
];
assert.deepEqual(pkg.files, requiredPackageFiles, 'release package allowlist must remain explicit');
for (const forbidden of ['test', 'scripts', '.github', '.gitmodules', 'src/codex-safe-core/test', 'src/codex-safe-core/.github', 'src/codex-safe-core/package.json', 'src/codex-safe-core/ARCHITECTURE.md', 'src/codex-safe-core/CONTRIBUTING.md']) {
  assert.equal(pkg.files.some(entry => entry === forbidden || entry.startsWith(`${forbidden}/`)), false, `release package must exclude ${forbidden}`);
}

const releasePath = path.join(root, '.github', 'workflows', 'release.yml');
assert.ok(fs.existsSync(releasePath), 'release workflow must exist');
const release = fs.readFileSync(releasePath, 'utf8');
assert.match(release, /branches:\s*\[main\]/, 'release must be driven by main');
assert.doesNotMatch(release, /tags:\s*\[/, 'workflow-created release tags must not recursively trigger another release run');
assert.match(release, /previous_version.*==.*version[\s\S]*git ls-remote --exit-code --refs origin "refs\/tags\/\$\{tag\}"[\s\S]*publish=false/, 'unchanged versions may be skipped only after the immutable tag exists');
assert.doesNotMatch(release, /--clobber/, 'immutable release assets must never be overwritten');
assert.match(release, /Release .* already exists; immutable assets will not be overwritten/, 'existing releases must fail closed');
assert.match(release, /actions\/attest-build-provenance@0f67c3f4856b2e3261c31976d6725780e5e4c373/, 'release provenance action must stay full-SHA pinned');
assert.match(release, /tar -tzf "\$tgz"/, 'release must inspect the actual TGZ contents');
assert.match(release, /release package contains development-only files/, 'release must fail on development-only package contents');
assert.match(release, /src\/codex-safe-core\/\(ARCHITECTURE/, 'release package gate must reject non-provenance Core development docs');

const sourceFiles = fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js'));
const source = sourceFiles.map(name => fs.readFileSync(path.join(root, 'src', name), 'utf8')).join('\n');
for (const forbidden of ['CODEX_RUNNER_SOCKET','GITLAB_PROJECT_ALLOWLIST','GITLAB_WEBHOOK_SECRET_TOKEN','X-Gitlab-Token','.codex-review.json']) {
  assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `runtime compatibility residue forbidden: ${forbidden}`);
}
assert.match(fs.readFileSync(path.join(root, 'src', 'codex.js'), 'utf8'), /codex-safe-core\/codex-cli/);
assert.match(fs.readFileSync(path.join(root, 'src', 'analyzers.js'), 'utf8'), /codex-safe-core\/review-rules/);
assert.match(fs.readFileSync(path.join(root, 'src', 'analyzers.js'), 'utf8'), /policy\?\.reviewRules \|\| \{\}/, 'deterministic analyzers must consume Policy v3 review.rules');
assert.match(fs.readFileSync(path.join(root, 'src', 'review.js'), 'utf8'), /buildReviewEvidenceChunks/);
assert.match(fs.readFileSync(path.join(root, 'src', 'policy.js'), 'utf8'), /parsePolicyDocument/);

for (const doc of ['README.md','README.zh-CN.md','OPERATIONS.md','SECURITY.md','LONG_TERM_ASSET.md','docs/ARCHITECTURE.md']) {
  const text = fs.readFileSync(path.join(root, doc), 'utf8');
  assert.doesNotMatch(text, /\.codex-review\.json/, `${doc} must not document the removed service-only policy`);
}

console.log('Codex Review Service Family v3 runtime, package boundary, recovery and immutable release policy verified.');
