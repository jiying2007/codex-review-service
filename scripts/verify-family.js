'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const core=require('../src/codex-safe-core');
const {SCHEMA_VERSION}=require('../src/db');
const contract=require('../product-contract.json');
const pkg=require('../package.json');
const root=path.resolve(__dirname,'..');

assert.equal(pkg.version,contract.serviceVersion);
assert.equal(pkg.engines.node,`>=${contract.minimumNodeVersion} <${contract.nodeMajorVersion+1}`);
assert.equal(core.SAFE_CORE_VERSION,contract.safeCoreMajorVersion);
assert.equal(core.SAFE_CONTRACT_VERSION,contract.safeContractVersion);
assert.equal(core.POLICY_SCHEMA_VERSION,contract.policySchemaVersion);
assert.equal(core.REVIEW_RECEIPT_SCHEMA_VERSION,contract.reviewReceiptVersion);
assert.equal(SCHEMA_VERSION,contract.databaseSchemaVersion);
const staged=execFileSync('git',['ls-files','--stage','src/codex-safe-core'],{cwd:root,encoding:'utf8'}).trim();
assert.match(staged,new RegExp(`^160000 ${contract.safeCoreCommit} 0\\tsrc/codex-safe-core$`));

const requiredPackageFiles=['.codex-safe.example.json','.env.example','CHANGELOG.md','LICENSE','LONG_TERM_ASSET.md','OPERATIONS.md','README.md','README.zh-CN.md','SUPPORT.md','SECURITY.md','VERIFY_RELEASE.md','config.example.json','product-contract.json','deploy/systemd/config.example.json','deploy/systemd/*.service','deploy/systemd/*.env.example','deploy/docker/Dockerfile','deploy/docker/compose.yaml','deploy/docker/README.md','deploy/docker/config.example.json','docs/ARCHITECTURE.md','docs/DEPLOYMENT.md','docs/DEPLOYMENT.zh-CN.md','docs/NOTIFICATIONS.md','docs/NOTIFICATIONS.zh-CN.md','docs/GITLAB_SETUP.md','docs/GITLAB_SETUP.zh-CN.md','src/*.js','src/codex-safe-core/index.js','src/codex-safe-core/safe-contract.js','src/codex-safe-core/codex-cli.js','src/codex-safe-core/process-runner.js','src/codex-safe-core/context-builder.js','src/codex-safe-core/policy.js','src/codex-safe-core/review-rules.js','src/codex-safe-core/git-repository.js','src/codex-safe-core/codex-safe.schema.json','src/codex-safe-core/CHANGELOG.md','src/codex-safe-core/LICENSE','src/codex-safe-core/README.md','src/codex-safe-core/README.zh-CN.md','src/codex-safe-core/SECURITY.md'];
assert.deepEqual(pkg.files,requiredPackageFiles);
for(const forbidden of ['test','scripts','.github','.gitmodules','src/codex-safe-core/test','src/codex-safe-core/.github','src/codex-safe-core/package.json','src/codex-safe-core/ARCHITECTURE.md','src/codex-safe-core/CONTRIBUTING.md'])assert.equal(pkg.files.some(entry=>entry===forbidden||entry.startsWith(`${forbidden}/`)),false,`release package must exclude ${forbidden}`);

const configs=['config.example.json','deploy/systemd/config.example.json','deploy/docker/config.example.json'].map(file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8')));for(const config of configs)assert.equal(config.schemaVersion,contract.configSchemaVersion);const[userConfig,systemConfig,dockerConfig]=configs;assert.equal(Object.hasOwn(userConfig.server||{},'dataDir'),false);assert.equal(Object.hasOwn(userConfig.runner||{},'socket'),false);assert.equal(systemConfig.server.dataDir,'/var/lib/codex-review');assert.equal(systemConfig.runner.socket,'/run/codex-review-runner/runner.sock');const normalized=structuredClone(systemConfig);delete normalized.server.dataDir;delete normalized.runner.socket;assert.deepEqual(normalized,userConfig);assert.equal(dockerConfig.server.host,'0.0.0.0');assert.equal(dockerConfig.server.dataDir,'/var/lib/codex-review');

const docker=fs.readFileSync(path.join(root,'deploy/docker/Dockerfile'),'utf8'),compose=fs.readFileSync(path.join(root,'deploy/docker/compose.yaml'),'utf8');assert.match(docker,/USER codex-review/);assert.match(docker,new RegExp(`FROM node:${contract.minimumNodeVersion}-bookworm-slim@sha256:[0-9a-f]{64}`));assert.match(compose,/read_only: true/);assert.match(compose,/cap_drop: \["ALL"\]/);assert.match(compose,/secrets:/);assert.doesNotMatch(compose,/env_file:/);

const dbSource=fs.readFileSync(path.join(root,'src/db.js'),'utf8'),notificationSource=fs.readFileSync(path.join(root,'src/notification.js'),'utf8'),secretSource=fs.readFileSync(path.join(root,'src/secrets.js'),'utf8'),indexSource=fs.readFileSync(path.join(root,'src/index.js'),'utf8'),httpSource=fs.readFileSync(path.join(root,'src/http.js'),'utf8'),adminSource=fs.readFileSync(path.join(root,'src/admin.js'),'utf8');assert.doesNotMatch(dbSource,/ALTER TABLE|hasColumn\(|migrate\(/);assert.match(dbSource,/EDBSCHEMA/);assert.match(dbSource,/notification_outbox/);assert.match(notificationSource,/review\.blocked/);assert.match(notificationSource,/service\.degraded/);assert.doesNotMatch(notificationSource,/mustache/i);assert.match(secretSource,/_FILE/);assert.match(secretSource,/mutually exclusive/);assert.match(indexSource,/fatal_runtime_error/);assert.match(indexSource,/unhandledRejection/);assert.match(indexSource,/uncaughtException/);assert.match(httpSource,/\/health\/dependencies/);assert.match(httpSource,/\/version/);assert.match(httpSource,/oldest_queue_age_seconds/);assert.match(adminSource,/node:sqlite/);assert.match(adminSource,/quick_check/);assert.match(adminSource,/foreign_key_check/);

const release=fs.readFileSync(path.join(root,'.github/workflows/release.yml'),'utf8');assert.match(release,/branches:\s*\[main\]/);assert.match(release,/github\.event\.comment\.body == '\/release-retry'/);assert.doesNotMatch(release,/--clobber/);assert.match(release,/Release .* already exists; immutable assets will not be overwritten/);assert.match(release,/docker buildx build[\s\S]*--file deploy\/docker\/Dockerfile[\s\S]*--platform linux\/amd64,linux\/arm64[\s\S]*--push/);assert.match(release,/IMAGE_DIGEST\.txt/);assert.match(release,/compose\.release\.yaml/);assert.match(release,/sha256sum "\$tgz" SBOM\.spdx\.json IMAGE_DIGEST\.txt compose\.release\.yaml > SHA256SUMS/);assert.match(release,/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8/);assert.match(release,/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/);

const ci=fs.readFileSync(path.join(root,'.github/workflows/ci.yml'),'utf8'),security=fs.readFileSync(path.join(root,'.github/workflows/security.yml'),'utf8'),gitlabMatrix=fs.readFileSync(path.join(root,'.github/workflows/gitlab-system.yml'),'utf8');assert.match(ci,/docker-smoke/);assert.match(ci,/recovery-gate/);assert.match(security,/npm audit --omit=dev --audit-level=high/);assert.match(security,/Denied runtime license/);assert.match(security,/codeql-action\/init@99df26d4f13ea111d4ec1a7dddef6063f76b97e9/);assert.doesNotMatch(security,/dependency-review-action/);assert.match(gitlabMatrix,/19\.1\.6-ce\.0/);assert.match(gitlabMatrix,/scripts\/gitlab-system-smoke\.js/);

const sourceFiles=fs.readdirSync(path.join(root,'src')).filter(name=>name.endsWith('.js')),source=sourceFiles.map(name=>fs.readFileSync(path.join(root,'src',name),'utf8')).join('\n');for(const forbidden of ['CODEX_RUNNER_SOCKET','GITLAB_PROJECT_ALLOWLIST','GITLAB_WEBHOOK_SECRET_TOKEN','X-Gitlab-Token','.codex-review.json','service_extension_schema'])assert.doesNotMatch(source,new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),`runtime compatibility residue forbidden: ${forbidden}`);

for(const doc of ['README.md','README.zh-CN.md','OPERATIONS.md','SECURITY.md','LONG_TERM_ASSET.md','docs/ARCHITECTURE.md','docs/DEPLOYMENT.md','docs/DEPLOYMENT.zh-CN.md','docs/NOTIFICATIONS.md','docs/NOTIFICATIONS.zh-CN.md','docs/GITLAB_SETUP.md','docs/GITLAB_SETUP.zh-CN.md','SUPPORT.md']){const text=fs.readFileSync(path.join(root,doc),'utf8');assert.doesNotMatch(text,/\.codex-review\.json/);if(!doc.includes('NOTIFICATIONS')&&!doc.includes('GITLAB_SETUP'))assert.doesNotMatch(text,/SQLite schema 4|SQLite Schema 4|\bNode 22\.13\b/i,`${doc} carries stale current product facts`);}

console.log(`Codex Review Service ${contract.serviceVersion}: Service v5 operations + exact Safe Core Family v4 boundary verified.`);
