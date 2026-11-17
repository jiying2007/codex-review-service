'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const pkg=require('../package.json');

test('multi deployment package contains runtime, closed templates and a rollback runbook',()=>{
 for(const filename of [
   'src/multi-gitlab-config.js','src/multi-gitlab-gateway.js',
   'src/multi-gitlab.js','src/multi-gitlab-preflight.js',
   'src/sharded-edge.js','src/sharded-catalog.js','src/repository-metrics.js',
   'deploy/docker/compose.multi.yaml','deploy/docker/multi-instance.example.json',
   'deploy/docker/sensor.config.example.json','docs/MULTI_GITLAB.zh-CN.md'
 ])assert.ok(fs.existsSync(filename),filename);
 for(const filename of [
   'deploy/docker/compose.multi.yaml','deploy/docker/multi-instance.example.json',
   'deploy/docker/sensor.config.example.json','docs/MULTI_GITLAB.zh-CN.md'
 ])assert.ok(pkg.files.includes(filename),'missing packaged multi deployment contract: '+filename);
 assert.ok(pkg.files.includes('src/*.js'),'new native runtime files must be packaged');
});
test('multi Compose never recreates the old DB volume or embeds credentials or an unverified tag',()=>{
 const text=fs.readFileSync('deploy/docker/compose.multi.yaml','utf8');
 assert.match(text,/ghcr\.io\/jiying2007\/codex-review-service@sha256:\$\{CODEX_REVIEW_IMAGE_DIGEST:\?/);
 assert.match(text,/CODEX_REVIEW_LEGACY_STATE_VOLUME:\?/);
 assert.match(text,/CODEX_REVIEW_LEGACY_HOME_VOLUME:\?/);
 assert.match(text,/external: true/);
 assert.match(text,/CODEX_REVIEW_MULTI_CONFIG_FILE:/);
 assert.match(text,/read_only: true/);
 assert.match(text,/cap_drop: \["ALL"\]/);
 assert.match(text,/no-new-privileges:true/);
 assert.match(text,/GITLAB_API_TOKEN_FILE|LEGACY_GITLAB_API_TOKEN_FILE/);
 assert.doesNotMatch(text,/\benv_file:/);
 assert.doesNotMatch(text,/^\s*build:/m);
 assert.match(text,/health\/live/,'liveness cannot restart all GitLab workers due to one failed tenant');
 assert.match(text,/127\.0\.0\.1:.*:8787/,'no implicit public exposure');
});
test('templates preserve old route while creating isolated sensor origin, scope and home',()=>{
 const manifest=JSON.parse(fs.readFileSync('deploy/docker/multi-instance.example.json','utf8'));
 const sensor=JSON.parse(fs.readFileSync('deploy/docker/sensor.config.example.json','utf8'));
 assert.equal(manifest.schemaVersion,1);
 assert.equal(manifest.server.defaultInstance,'legacy');
 assert.deepEqual(manifest.instances.map(i=>i.id),['legacy','sensor']);
 assert.notDeepEqual(manifest.instances[0].secretFiles,manifest.instances[1].secretFiles);
 assert.equal(sensor.schemaVersion,8);
 assert.equal(sensor.server.port,8787);
 assert.equal(sensor.gitlab.baseUrl,'http://192.168.2.50');
 assert.deepEqual(sensor.gitlab.projects,[113]);
 assert.deepEqual(sensor.gitlab.groups,[]);
 assert.equal(sensor.webhook.expectedInstance,'http://192.168.2.50');
 assert.deepEqual(sensor.review.triggerAssignment,{mode:'always',userIds:[]});
 assert.equal(sensor.notifications.enabled,false,'notifications require separate identity mapping');
});
test('repository ignores active multi-tenant config and secret files',()=>{
 const text=fs.readFileSync('.gitignore','utf8');
 for(const item of ['deploy/docker/multi-instance.json','deploy/docker/legacy.json',
   'deploy/docker/sensor.json','deploy/docker/catalog.json','deploy/docker/secrets/'])
   assert.ok(text.includes(item),item);
});

test('Sensor runbook does not misrepresent disabled notifications or trigger flags as a no-model switch',()=>{
 const sensor=JSON.parse(fs.readFileSync('deploy/docker/sensor.config.example.json','utf8'));
 const guide=fs.readFileSync('docs/MULTI_GITLAB.zh-CN.md','utf8');
 assert.equal(sensor.review.triggerAssignment.mode,'always');
 assert.equal(sensor.notifications.enabled,false);
 assert.match(guide,/notifications\.enabled=false[^\n]*不代表模型不会调用/);
 assert.match(guide,/triggerOnOpen[^\n]*triggerOnPush[^\n]*triggerOnReopen[^\n]*false/);
 assert.match(guide,/source_branch[^\n]*target_branch/);
 assert.match(guide,/\/codex review/);
 assert.match(guide,/不要执行[^\n]*docker compose up/);
 assert.match(guide,/multi-gitlab-preflight\.js/);
 assert.match(guide,/不是产品内新增的强制无模型开关/);
});


test('the release package explicitly includes sharded deployment and no-model inventory entrypoints',()=>{
 const files=['deploy/docker/compose.sharded.yaml','deploy/docker/nginx.sharded.conf',
   'docs/MULTI_GITLAB_SHARDED.zh-CN.md'];
 for(const filename of files){
   assert.ok(fs.existsSync(filename),filename);
   assert.ok(pkg.files.includes(filename),'missing packaged sharded deployment file: '+filename);
 }
 for(const file of ['src/multi-instance-inventory.js','src/sharded-deploy-check.js'])
   assert.ok(fs.existsSync(file),'missing safe CLI entrypoint: '+file);
 const guide=fs.readFileSync('docs/MULTI_GITLAB_SHARDED.zh-CN.md','utf8');
 assert.match(guide,/不能在旧 Legacy 在线时启用新 Legacy Writer/);
 assert.match(guide,/CODEX_REVIEW_IMAGE_DIGEST/);
 assert.match(guide,/node src\/sharded-deploy-check\.js/);
 assert.match(guide,/不是严格的“无模型”开关/);
});
