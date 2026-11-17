'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const pkg=require('../package.json');
test('v8 ships explicit fleet config, isolated instance and credential-free Edge',()=>{
 for(const path of [
   'src/multi-gitlab-config.js','src/multi-gitlab-gateway.js',
   'src/multi-gitlab-preflight.js','src/sharded-edge.js',
   'src/sharded-catalog.js','src/sharded-deploy-check.js',
   'deploy/docker/compose.instance.yaml','deploy/docker/compose.sharded.yaml',
   'deploy/docker/multi-instance.example.json',
   'docs/MULTI_GITLAB.zh-CN.md','docs/MULTI_GITLAB_SHARDED.zh-CN.md'
 ])assert.ok(fs.existsSync(path),path);
 for(const path of [
   'deploy/docker/compose.instance.yaml','deploy/docker/compose.sharded.yaml',
   'deploy/docker/multi-instance.example.json','docs/MULTI_GITLAB.zh-CN.md',
   'docs/MULTI_GITLAB_SHARDED.zh-CN.md'
 ])assert.ok(pkg.files.includes(path),'release package must ship '+path);
 assert.equal(fs.existsSync('deploy/docker/nginx.sharded.conf'),false);
 assert.equal(pkg.files.includes('deploy/docker/nginx.sharded.conf'),false);
});
test('v8 manifest has explicit instance IDs and rejects defaultInstance field',()=>{
 const m=JSON.parse(fs.readFileSync('deploy/docker/multi-instance.example.json','utf8'));
 assert.equal(m.schemaVersion,2);
 assert.deepEqual(m.instances.map(x=>x.id),['primary','sensor']);
 assert.equal(Object.hasOwn(m.server,'defaultInstance'),false);
 assert.notDeepEqual(m.instances[0].secretFiles,m.instances[1].secretFiles);
 const spec=JSON.parse(fs.readFileSync('deploy/docker/sensor.config.example.json','utf8'));
 assert.equal(spec.schemaVersion,8);
 assert.equal(spec.webhook.expectedInstance,'http://192.168.2.50');
 const gateway=fs.readFileSync('src/multi-gitlab-gateway.js','utf8');
 assert.doesNotMatch(gateway,/defaultInstance|method === 'POST' && url.pathname === '\/webhooks\/gitlab'/);
});
test('both deployment options are opt-in and do not publish Worker ports by default',()=>{
 const multi=fs.readFileSync('deploy/docker/compose.multi.yaml','utf8');
 const edge=fs.readFileSync('deploy/docker/compose.sharded.yaml','utf8');
 const instance=fs.readFileSync('deploy/docker/compose.instance.yaml','utf8');
 assert.ok(multi.includes('profiles: ["explicit-multi-thread"]'));
 assert.ok(edge.includes('profiles: ["cutover-edge"]'));
 assert.ok(instance.includes('profiles: ["cutover-standalone"]'));
 assert.ok(edge.includes('CODEX_REVIEW_SHARDED_TARGETS_FILE'));
 assert.doesNotMatch(edge,/^\s+secrets:\s*$/m);
 for(const prohibited of ['/run/secrets','cutover-legacy','cutover-sensor'])
  assert.equal(edge.includes(prohibited),false,'Edge must not contain '+prohibited);
 assert.doesNotMatch(instance,/^\s+ports:|^\s+build:/m);
 assert.doesNotMatch(multi,/^\s+build:|^\s+env_file:/m);
 assert.match(multi,/127\.0\.0\.1:/);
 assert.match(edge,/127\.0\.0\.1:/);
});
test('ignore rules exclude operator files; runbooks forbid unverified model startup',()=>{
 const ignore=fs.readFileSync('.gitignore','utf8');
 for(const item of ['deploy/docker/multi-instance.json',
   'deploy/docker/catalog.json','deploy/docker/secrets/'])
   assert.ok(ignore.includes(item),item);
 const docs=fs.readFileSync('docs/MULTI_GITLAB_SHARDED.zh-CN.md','utf8');
 for(const term of ['唯一 Writer','只读','Catalog Schema 2','/webhooks/gitlab/<instance-id>',
   'notifications.enabled=false'])
   assert.ok(docs.includes(term),term);
});
