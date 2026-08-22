'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const changelogPath = path.join(root, 'CHANGELOG.md');
const EXPECTED_CORE_COMMIT = 'e6e25b502aa35a079f660346785cf283fe293b6d';

function fail(message) { throw new Error(message); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function run(command, args, options = {}) { return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: options.stdio || ['ignore','pipe','pipe'] }).trim(); }
function validVersion(value) { return /^\d+\.\d+\.\d+$/.test(String(value || '')); }

function verifyStatic() {
  const pkg = readJson(pkgPath);
  const lock = readJson(lockPath);
  if (!validVersion(pkg.version)) fail(`package version must be MAJOR.MINOR.PATCH: ${pkg.version}`);
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) fail('package-lock version metadata must match package.json.');
  const changelog = fs.readFileSync(changelogPath, 'utf8');
  if (!changelog.includes(`\n## ${pkg.version}\n`)) fail(`CHANGELOG.md must contain ## ${pkg.version}.`);
  const staged = run('git', ['ls-files','--stage','src/codex-safe-core']);
  const match = staged.match(/^160000 ([0-9a-f]{40,64}) 0\tsrc\/codex-safe-core$/i);
  if (!match || match[1] !== EXPECTED_CORE_COMMIT) fail(`src/codex-safe-core must pin ${EXPECTED_CORE_COMMIT}.`);
  const sourceFiles = fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js'));
  const source = sourceFiles.map(name => fs.readFileSync(path.join(root, 'src', name), 'utf8')).join('\n');
  for (const forbidden of ['CODEX_RUNNER_SOCKET','GITLAB_PROJECT_ALLOWLIST','GITLAB_WEBHOOK_SECRET_TOKEN','X-Gitlab-Token','.codex-review.json']) {
    if (source.includes(forbidden)) fail(`runtime compatibility residue remains: ${forbidden}`);
  }
  return pkg.version;
}

function prepare(version) {
  if (!validVersion(version)) fail('Usage: npm run release:prepare -- X.Y.Z');
  const pkg = readJson(pkgPath);
  const lock = readJson(lockPath);
  pkg.version = version;
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  let changelog = fs.readFileSync(changelogPath, 'utf8');
  if (!changelog.includes(`\n## ${version}\n`)) changelog = changelog.replace('## Unreleased\n', `## Unreleased\n\n## ${version}\n\n- Release prepared. Replace this line with final release notes before merge.\n`);
  fs.writeFileSync(changelogPath, changelog);
  console.log(`Prepared ${version}.`);
}

function check() {
  const version = verifyStatic();
  run('npm', ['run','ci'], { stdio: 'inherit' });
  run('npm', ['pack','--dry-run','--ignore-scripts'], { stdio: 'inherit' });
  console.log(`READY FOR v${version}`);
}

function push() {
  const branch = run('git', ['branch','--show-current']);
  if (branch !== 'main') fail('release:push requires main.');
  const version = verifyStatic();
  check();
  run('git', ['push','origin','main'], { stdio: 'inherit' });
  console.log(`Pushed main for v${version}; GitHub Release workflow owns tag/artifact publication.`);
}

const [command, value] = process.argv.slice(2);
Promise.resolve().then(() => {
  if (command === 'prepare') return prepare(value);
  if (command === 'check') return check();
  if (command === 'push') return push();
  fail('Usage: node scripts/release.js <prepare X.Y.Z|check|push>');
}).catch(error => { console.error(error.message || error); process.exit(1); });
