'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {verifyDistinctSecretFiles}=require('../src/sharded-deploy-check');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'review-sharded-secret-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const env={};
 for(const name of ['LEGACY_GITLAB_API_TOKEN_FILE','LEGACY_GITLAB_WEBHOOK_TOKEN_FILE',
   'SENSOR_GITLAB_API_TOKEN_FILE','SENSOR_GITLAB_WEBHOOK_TOKEN_FILE']){
   const file=path.join(root,name+'.txt');
   fs.writeFileSync(file,'fixture-secret-'+name,{mode:0o600});
   fs.chmodSync(file,0o600);
   env[name]=file;
 }
 return {root,env};
}
test('offline sharded preflight verifies distinct credential contents without printing values',t=>{
 const {env}=fixture(t);
 const result=verifyDistinctSecretFiles(env);
 assert.deepEqual(result,{secretFilesVerified:4,credentialContentsDistinct:true});
 assert.doesNotMatch(JSON.stringify(result),/fixture-secret|_FILE|\/tmp/);
 fs.writeFileSync(env.SENSOR_GITLAB_API_TOKEN_FILE,'fixture-secret-LEGACY_GITLAB_API_TOKEN_FILE');
 assert.throws(()=>verifyDistinctSecretFiles(env),/reuse a credential/);
});
test('credentials must be private, bounded, singly-linked and not symlinked',t=>{
 const {root,env}=fixture(t);
 fs.chmodSync(env.SENSOR_GITLAB_API_TOKEN_FILE,0o644);
 if(process.platform!=='win32')assert.throws(()=>verifyDistinctSecretFiles(env),/private/);
 fs.chmodSync(env.SENSOR_GITLAB_API_TOKEN_FILE,0o600);
 const extra=path.join(root,'duplicate-link');
 fs.linkSync(env.SENSOR_GITLAB_API_TOKEN_FILE,extra);
 assert.throws(()=>verifyDistinctSecretFiles(env),/singly linked/);
 fs.unlinkSync(extra);
 if(process.platform!=='win32'){
   fs.renameSync(env.SENSOR_GITLAB_API_TOKEN_FILE,extra);
   fs.symlinkSync(extra,env.SENSOR_GITLAB_API_TOKEN_FILE);
   assert.throws(()=>verifyDistinctSecretFiles(env),/ELOOP|symbolic/i);
 }
});
