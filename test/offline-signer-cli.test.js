'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {digest,REQUIRED,verifyEvidence}=require('../scripts/offline-evidence');
const program=path.resolve(__dirname,'../scripts/sign-offline-evidence.js');
const sha='b'.repeat(40);
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'offline-signer-cli-'));
 const ci=crypto.generateKeyPairSync('ed25519'),review=crypto.generateKeyPairSync('ed25519');
 const key=(id,pair)=>{
   const file=path.join(dir,id+'.pem');
   fs.writeFileSync(file,pair.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
   return file;
 };
 const ciKey=key('ci',ci),reviewKey=key('review',review);
 const trustFile=path.join(dir,'trust.json');
 const trust={schemaVersion:1,repository:'jiying2007/codex-review-service',maxAgeHours:72,
   ci:{keyId:'ci-key',allowedIdentities:['ci-operator'],publicKeyPem:ci.publicKey.export({type:'spki',format:'pem'})},
   review:{keyId:'review-key',allowedIdentities:['code-reviewer'],publicKeyPem:review.publicKey.export({type:'spki',format:'pem'})}};
 fs.writeFileSync(trustFile,JSON.stringify(trust),{mode:0o600});
 const logs=path.join(dir,'logs');fs.mkdirSync(logs);
 const suites=REQUIRED.production.map(id=>{
   const data=Buffer.from('TEST ONLY '+id+' measured log\n');
   fs.writeFileSync(path.join(logs,id+'.log'),data);
   return{id,exitCode:0,durationMs:3,logSha256:digest(data)};
 });
 const ciPayload={schemaVersion:1,kind:'ci',repository:trust.repository,sha,author:'change-author',
   issuer:'ci-operator',runner:'isolated-linux',issuedAt:new Date(Date.now()-2000).toISOString(),suites};
 const ciUnsigned=path.join(dir,'ci.unsigned.json'),ciSigned=path.join(dir,'ci.signed.json'),reviewSigned=path.join(dir,'review.signed.json');
 fs.writeFileSync(ciUnsigned,JSON.stringify(ciPayload));
 const run=(...args)=>spawnSync(process.execPath,[program,...args],{encoding:'utf8'});
 const base=['--mode','production','--trust',trustFile,'--logs',logs,'--sha',sha,'--author','change-author'];
 return{dir,logs,trustFile,ciKey,reviewKey,ciUnsigned,ciSigned,reviewSigned,run,base,close:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('trusted CI signer and independent reviewer CLI produce verifiable production receipts',()=>{
 const f=fixture();try{
   const c=f.run('--type','ci',...f.base,'--input',f.ciUnsigned,'--key',f.ciKey,'--key-id','ci-key','--output',f.ciSigned);
   assert.equal(c.status,0,c.stderr);
   const r=f.run('--type','review',...f.base,'--ci',f.ciSigned,'--reviewer','code-reviewer',
     '--key',f.reviewKey,'--key-id','review-key','--output',f.reviewSigned);
   assert.equal(r.status,0,r.stderr);
   const result=verifyEvidence({trustFile:f.trustFile,ciFile:f.ciSigned,reviewFile:f.reviewSigned,
     logsDir:f.logs,sha,author:'change-author',mode:'production'});
   assert.equal(result.ok,true);
   assert.equal(result.independentlyReviewed,true);
 }finally{f.close();}
});
test('CI signer refuses tampered raw logs and unauthorized signer key',()=>{
 const f=fixture();try{
   fs.appendFileSync(path.join(f.logs,'syntax.log'),'tampered');
   const bad=f.run('--type','ci',...f.base,'--input',f.ciUnsigned,'--key',f.ciKey,'--key-id','ci-key','--output',f.ciSigned);
   assert.equal(bad.status,2);assert.equal(fs.existsSync(f.ciSigned),false);
   fs.writeFileSync(path.join(f.logs,'syntax.log'),'TEST ONLY syntax measured log\n');
   const wrong=f.run('--type','ci',...f.base,'--input',f.ciUnsigned,'--key',f.reviewKey,'--key-id','ci-key','--output',f.ciSigned);
   assert.equal(wrong.status,2);assert.equal(fs.existsSync(f.ciSigned),false);
 }finally{f.close();}
});
