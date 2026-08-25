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
const read=name=>fs.readFileSync(path.join(root,name),'utf8');

assert.equal(pkg.version,contract.serviceVersion);
assert.equal(pkg.engines.node,contract.nodeEngine);
assert.equal(core.SAFE_CORE_VERSION,contract.safeCoreMajorVersion);
assert.equal(core.SAFE_CONTRACT_VERSION,contract.safeContractVersion);
assert.equal(core.POLICY_SCHEMA_VERSION,contract.policySchemaVersion);
assert.equal(core.REVIEW_RECEIPT_SCHEMA_VERSION,contract.reviewReceiptVersion);
assert.equal(SCHEMA_VERSION,contract.databaseSchemaVersion);

const staged=execFileSync('git',['ls-files','--stage','src/codex-safe-core'],{cwd:root,encoding:'utf8'}).trim();
assert.match(staged,new RegExp(`^160000 ${contract.safeCoreCommit} 0\\tsrc/codex-safe-core$`));

const example=JSON.parse(read('.codex-safe.example.json'));
assert.equal(example.schemaVersion,contract.policySchemaVersion);
assert.match(String(example.$schema||''),new RegExp(contract.safeCoreCommit));

const userConfig=JSON.parse(read('config.example.json'));
const systemConfig=JSON.parse(read('deploy/systemd/config.example.json'));
const dockerConfig=JSON.parse(read('deploy/docker/config.example.json'));
for(const config of [userConfig,systemConfig,dockerConfig]) assert.equal(config.schemaVersion,contract.configSchemaVersion);
assert.equal(Object.hasOwn(userConfig.server||{},'dataDir'),false);
assert.equal(systemConfig.server.dataDir,'/var/lib/codex-review');
assert.equal(dockerConfig.server.host,'0.0.0.0');
assert.equal(dockerConfig.server.dataDir,'/var/lib/codex-review');

const docker=read('deploy/docker/Dockerfile');
const compose=read('deploy/docker/compose.yaml');
assert.match(docker,/FROM node:24\.19\.0-bookworm-slim@sha256:[0-9a-f]{64}/);
assert.match(docker,/USER codex-review/);
assert.match(compose,/read_only: true/);
assert.match(compose,/cap_drop: \["ALL"\]/);
assert.match(compose,/secrets:/);
assert.doesNotMatch(compose,/env_file:/);

const configSource=read('src/config.js');
const secretSource=read('src/secrets.js');
const notificationSource=read('src/notification.js');
const dbSource=read('src/db.js');
const httpSource=read('src/http.js');
const indexSource=read('src/index.js');
assert.match(configSource,/configSchemaVersion/);
assert.match(configSource,/Unsupported config schema/);
assert.match(secretSource,/_FILE/);
assert.match(secretSource,/mutually exclusive/);
assert.match(notificationSource,/review\.blocked/);
assert.match(notificationSource,/service\.degraded/);
assert.match(notificationSource,/open\.feishu\.cn/);
assert.match(notificationSource,/qyapi\.weixin\.qq\.com/);
assert.doesNotMatch(notificationSource,/mustache/i);
assert.match(dbSource,/notification_outbox/);
assert.match(dbSource,/saveRunWithOutbox/);
assert.match(dbSource,/recoverNotifications/);
assert.match(dbSource,/EDBSCHEMA/);
assert.doesNotMatch(dbSource,/ALTER TABLE|hasColumn\(|migrate\(/);
assert.match(httpSource,/\/health\/dependencies/);
assert.match(httpSource,/oldest_queue_age_seconds/);
assert.match(indexSource,/fatal/);

const requiredPackageFiles=['product-contract.json','src/*.js','deploy/docker/Dockerfile','deploy/docker/compose.yaml'];
for(const item of requiredPackageFiles) assert.ok(pkg.files.includes(item),`release package missing ${item}`);
for(const forbidden of ['test','scripts','.github','.gitmodules']) assert.equal(pkg.files.some(v=>v===forbidden||v.startsWith(`${forbidden}/`)),false);

const release=read('.github/workflows/release.yml');
assert.match(release,/branches:\s*\[main\]/);
assert.match(release,/ghcr\.io/);
assert.match(release,/--sbom=true/);
assert.match(release,/--provenance=mode=max/);
assert.match(release,/IMAGE_DIGEST\.txt/);
assert.match(release,/compose\.release\.yaml/);
assert.match(release,/sha256sum "\$tgz" SBOM\.spdx\.json IMAGE_DIGEST\.txt compose\.release\.yaml > SHA256SUMS/);
assert.match(release,/actions\/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8/);
assert.doesNotMatch(release,/--clobber/);
assert.match(release,/immutable assets will not be overwritten/);

const security=read('.github/workflows/security.yml');
assert.match(security,/github\/codeql-action\/init@99df26d4f13ea111d4ec1a7dddef6063f76b97e9/);
assert.match(security,/npm audit --omit=dev --audit-level=high/);

for(const doc of ['README.md','README.zh-CN.md','OPERATIONS.md','SECURITY.md','LONG_TERM_ASSET.md','docs/ARCHITECTURE.md','docs/DEPLOYMENT.md','docs/DEPLOYMENT.zh-CN.md','docs/NOTIFICATIONS.md','docs/NOTIFICATIONS.zh-CN.md','docs/GITLAB_SETUP.md','docs/GITLAB_SETUP.zh-CN.md','SUPPORT.md']){
  const text=read(doc);
  assert.doesNotMatch(text,/\.codex-review\.json/);
  assert.doesNotMatch(text,/SQLite schema 4|SQLite Schema 4|Schema 4 is the first supported production database/);
}

console.log(`Codex Review Service ${contract.serviceVersion}: Core ${contract.safeCoreMajorVersion}, DB Schema ${contract.databaseSchemaVersion}, Config Schema ${contract.configSchemaVersion}, Node ${contract.minimumNodeVersion}, OCI/DR/security gates verified.`);
