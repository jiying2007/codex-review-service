'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {verifyDistinctSecretFiles}=require('../src/sharded-deploy-check');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'review-credentials-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const names=['primary-api','primary-webhook','sensor-api','sensor-webhook'];
 const files=names.map(name=>{
   const file=path.join(root,name);
   fs.writeFileSync(file,'nonprod-secret-'+name,{mode:0o600});
   fs.chmodSync(file,0o600);return file;
 });
 return {root,files};
}
test('explicit credential file arrays are content-distinct and do not disclose values',t=>{
 const {files}=fixture(t);
 const report=verifyDistinctSecretFiles(files);
 assert.deepEqual(report,{filesVerified:4,credentialContentsDistinct:true,secretsExposed:false});
 assert.doesNotMatch(JSON.stringify(report),/nonprod-secret|\/tmp|primary-api|sensor-api/);
 fs.writeFileSync(files[2],'nonprod-secret-primary-api');
 assert.throws(()=>verifyDistinctSecretFiles(files),/reuse/);
 assert.throws(()=>verifyDistinctSecretFiles([files[0],files[0]]),/unique path/);
});
test('credential files must be private regular bounded non-linked files',t=>{
 const {root,files}=fixture(t);
 fs.chmodSync(files[2],0o644);
 if(process.platform!=='win32')assert.throws(()=>verifyDistinctSecretFiles(files),/private/);
 fs.chmodSync(files[2],0o600);
 const other=path.join(root,'hardlink');
 fs.linkSync(files[2],other);
 assert.throws(()=>verifyDistinctSecretFiles(files),/singly linked/);
 fs.unlinkSync(other);
 if(process.platform!=='win32'){
   fs.renameSync(files[2],other);
   fs.symlinkSync(other,files[2]);
   assert.throws(()=>verifyDistinctSecretFiles(files),/ELOOP|symbolic|link/i);
 }
});
