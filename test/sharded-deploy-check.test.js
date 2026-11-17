'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {checkShardedConfig}=require('../src/sharded-deploy-check');
const {buildShardedCatalog}=require('../src/sharded-catalog');

const env={CODEX_REVIEW_IMAGE_DIGEST:'a'.repeat(64),CODEX_REVIEW_EDGE_PORT:'8799'};
const config=(id,url)=>({schemaVersion:8,server:{host:'0.0.0.0',port:8787},
  gitlab:{baseUrl:url,projects:[113],groups:[]},webhook:{expectedInstance:url}});
const configs={primary:config('primary','http://192.168.1.4'),
  sensor:config('sensor','http://192.168.2.50')};
const catalog=buildShardedCatalog(configs);
const targets={primary:{host:'primary',port:8787},sensor:{host:'sensor',port:8787}};
test('v8 preflight validates catalog and explicit targets without requiring Edge secrets',()=>{
 const report=checkShardedConfig({env,configs,catalog,targets});
 assert.equal(report.schemaVersion,2);
 assert.equal(report.modelCalls,0);
 assert.equal(report.productionQualified,false);
 assert.equal(report.configScopeVerified,true);
 assert.equal(report.instanceCount,2);
 assert.deepEqual(report.configuredProjectKeys,['primary:113','sensor:113']);
 assert.equal(report.edgeTargetMapVerified,true);
 assert.doesNotMatch(JSON.stringify(report),/SECRET|TOKEN|apiKey|\/secure/);
 const single={qa:config('qa','https://qa.example.test')};
 const only=checkShardedConfig({env,catalog:buildShardedCatalog(single),
   targets:{qa:{host:'qa',port:8787}}});
 assert.equal(only.instanceCount,1);
 assert.equal(only.configScopeVerified,null);
});
test('v8 preflight refuses stale catalog, unsafe host, arbitrary target, invalid index',()=>{
 assert.throws(()=>checkShardedConfig({env:{...env,CODEX_REVIEW_IMAGE_DIGEST:'main'},catalog,targets}),/digest/);
 assert.throws(()=>checkShardedConfig({env,catalog:{...catalog,schemaVersion:1},targets}),/invalid schema/);
 assert.throws(()=>checkShardedConfig({env,catalog,targets:{...targets,sensor:{host:'169.254.169.254',port:80}}}),/fixed trusted/);
 assert.throws(()=>checkShardedConfig({env,catalog,targets:{primary:targets.primary}}),/fixed trusted/);
 assert.throws(()=>checkShardedConfig({env,catalog,targets,configs:{...configs,sensor:config('sensor','https://other.example')}}),/differs/);
 assert.throws(()=>checkShardedConfig({env:{...env,CODEX_REVIEW_EDGE_PORT:8787},catalog,targets}),/port/);
});
test('v8 sharded Compose deploys only credential-free ingress with explicit target mapping',()=>{
 const yaml=fs.readFileSync('deploy/docker/compose.sharded.yaml','utf8');
 assert.ok(yaml.includes('profiles: ["cutover-edge"]'));
 assert.ok(yaml.includes('CODEX_REVIEW_SHARDED_TARGETS_FILE'));
 assert.ok(yaml.includes('CODEX_REVIEW_CATALOG_FILE'));
 assert.ok(yaml.includes('CODEX_REVIEW_PRIVATE_NETWORK'));
 assert.ok(yaml.includes('127.0.0.1:'));
 assert.ok(yaml.includes('command: ["node", "src/sharded-edge.js"]'));
 assert.doesNotMatch(yaml,/^\s*(?:build|env_file|secrets|legacy|sensor):/m);
 assert.doesNotMatch(yaml,/\/run\/secrets|GITLAB_API_TOKEN_FILE|OPENAI_API_KEY|cutover-legacy|cutover-sensor/);
 assert.doesNotMatch(yaml,/^\s+-\s+"0\.0\.0\.0:/m);
 assert.equal(fs.existsSync('deploy/docker/nginx.sharded.conf'),false,'no old default-route proxy is shipped');
});
