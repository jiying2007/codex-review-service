'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {checkShardedConfig}=require('../src/sharded-deploy-check');
const env={
 CODEX_REVIEW_IMAGE_DIGEST:'a'.repeat(64),CODEX_REVIEW_EDGE_IMAGE:'nginx:1.29-alpine@sha256:'+'b'.repeat(64),
 CODEX_REVIEW_LEGACY_STATE_VOLUME:'old-volume',CODEX_REVIEW_LEGACY_HOME_VOLUME:'old-home',
 LEGACY_GITLAB_API_TOKEN_FILE:'/secure/legacy-api',
 LEGACY_GITLAB_WEBHOOK_TOKEN_FILE:'/secure/legacy-hook',
 SENSOR_GITLAB_API_TOKEN_FILE:'/secure/sensor-api',
 SENSOR_GITLAB_WEBHOOK_TOKEN_FILE:'/secure/sensor-hook'
};
const instance=(name,origin)=>({
 schemaVersion:8,server:{host:'0.0.0.0',port:8787,dataDir:'/var/lib/codex-review/'+name},
 codex:{home:'/home/codex-review/'+name},
 gitlab:{baseUrl:origin,projects:[113],groups:[]},webhook:{expectedInstance:origin}
});
const legacy=instance('legacy','http://192.168.1.4'),sensor=instance('sensor','http://192.168.2.50');
test('preflight requires an immutable image and unique instance-qualified project key',()=>{
 const result=checkShardedConfig({env,legacy,sensor});
 assert.equal(result.readyForReadOnlyPreflight,true);
 assert.equal(result.productionQualified,false);
 assert.equal(result.modelCalls,0);
 assert.deepEqual(result.configuredProjectKeys,['legacy:113','sensor:113']);
 const data=JSON.stringify(result);
 assert.equal(data.includes('/secure'),false);
 assert.equal(data.includes('old-volume'),false);
});
test('preflight rejects unsafe image, overlapping credentials, shared state, stale config and origins',()=>{
 const options={env,legacy,sensor};
 assert.throws(()=>checkShardedConfig({...options,env:{...env,CODEX_REVIEW_IMAGE_DIGEST:'main'}}),/digest/);
 assert.throws(()=>checkShardedConfig({...options,env:{...env,CODEX_REVIEW_EDGE_IMAGE:'nginx:latest'}}),/pinned/);
 assert.throws(()=>checkShardedConfig({...options,env:{...env,SENSOR_GITLAB_API_TOKEN_FILE:env.LEGACY_GITLAB_API_TOKEN_FILE}}),/reuse/);
 assert.throws(()=>checkShardedConfig({...options,sensor:{...sensor,server:{...sensor.server,dataDir:legacy.server.dataDir}}}),/isolated/);
 assert.throws(()=>checkShardedConfig({...options,sensor:{...sensor,schemaVersion:7}}),/Schema 8/);
 assert.throws(()=>checkShardedConfig({...options,sensor:{...sensor,server:{...sensor.server,host:'127.0.0.1'}}}),/bridge/);
 assert.throws(()=>checkShardedConfig({...options,sensor:{...sensor,gitlab:{...sensor.gitlab,baseUrl:legacy.gitlab.baseUrl}}}),/origin/);
});
test('sharded deployment template never starts a model Worker by bare compose up',()=>{
 const text=fs.readFileSync('deploy/docker/compose.sharded.yaml','utf8');
 assert.match(text,/profiles: \["cutover-legacy"\]/);
 assert.match(text,/profiles: \["cutover-sensor"\]/);
 assert.match(text,/profiles: \["cutover-edge"\]/);
 assert.match(text,/legacy-state:\s*\n\s+external: true/);
 assert.match(text,/legacy-home:\s*\n\s+external: true/);
 assert.match(text,/127\.0\.0\.1:\$\{CODEX_REVIEW_EDGE_PORT/);
 assert.match(text,/read_only: true/);
 assert.match(text,/no-new-privileges:true/);
 assert.doesNotMatch(text,/^\s*build:/m);
 assert.doesNotMatch(text,/^\s*env_file:/m);
 assert.doesNotMatch(text,/ports:\s*\n\s*- "0\.0\.0\.0:/);
 const proxy=fs.readFileSync('deploy/docker/nginx.sharded.conf','utf8');
 assert.match(proxy,/location = \/webhooks\/gitlab\/sensor \{/);
 assert.match(proxy,/proxy_pass http:\/\/sensor:8787\/webhooks\/gitlab/);
 assert.match(proxy,/location = \/webhooks\/gitlab \{/);
 assert.match(proxy,/proxy_pass http:\/\/legacy:8787\/webhooks\/gitlab/);
 assert.match(proxy,/return 404/);
});
