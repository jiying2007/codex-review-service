'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {verifyEvidence,signedMessage,digest,REQUIRED,main}=require('../scripts/offline-evidence');
const SHA='a'.repeat(40),OTHER_SHA='b'.repeat(40);
function fixtures(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'offline-gate-'));
  const logs=path.join(root,'logs');fs.mkdirSync(logs);
  const now=Date.now(),date=new Date(now-2000).toISOString();
  const ciKeys=crypto.generateKeyPairSync('ed25519');
  const reviewKeys=crypto.generateKeyPairSync('ed25519');
  const trustFile=path.join(root,'trusted-admin-root.json');
  const ciFile=path.join(root,'ci.signed.json');
  const reviewFile=path.join(root,'review.signed.json');
  const trust={schemaVersion:1,repository:'jiying2007/codex-review-service',maxAgeHours:72,
    ci:{keyId:'ci-key',allowedIdentities:['ci-operator'],allowedRunners:['isolated-linux'],publicKeyPem:ciKeys.publicKey.export({type:'spki',format:'pem'})},
    review:{keyId:'review-key',allowedIdentities:['independent-reviewer'],publicKeyPem:reviewKeys.publicKey.export({type:'spki',format:'pem'})}};
  const suiteResults=REQUIRED.production.map(id=>{
    const content=Buffer.from('Real measured '+id+' success log\n');
    fs.writeFileSync(path.join(logs,id+'.log'),content);
    return{id,exitCode:0,durationMs:1000,logSha256:digest(content)};
  });
  let ci={schemaVersion:1,kind:'ci',repository:trust.repository,sha:SHA,author:'change-author',
    issuer:'ci-operator',runner:'isolated-linux',issuedAt:date,suites:suiteResults};
  let review={schemaVersion:1,kind:'review',repository:trust.repository,sha:SHA,author:'change-author',
    reviewer:'independent-reviewer',decision:'approved',issuedAt:new Date(now-1000).toISOString(),ciSha256:''};
  function seal(payload,key,id){const envelope={schemaVersion:1,keyId:id,payload};return {...envelope,signature:crypto.sign(null,signedMessage(envelope),key).toString('base64')};}
  function persist(){
    fs.writeFileSync(trustFile,JSON.stringify(trust),{mode:0o600});
    fs.writeFileSync(ciFile,JSON.stringify(seal(ci,ciKeys.privateKey,trust.ci.keyId)));
    review.ciSha256=digest(fs.readFileSync(ciFile));
    fs.writeFileSync(reviewFile,JSON.stringify(seal(review,reviewKeys.privateKey,trust.review.keyId)));
  }
  persist();
  const opts={trustFile,ciFile,reviewFile,logsDir:logs,sha:SHA,author:'change-author',mode:'production',now};
  return {root,logs,ci,review,trust,ciKeys,reviewKeys,persist,opts,ciFile,reviewFile,trustFile,
    close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('approved independent CI and review are bound to exact SHA, suite logs, and two distinct keys',()=>{
  const f=fixtures();try{
    const ok=verifyEvidence(f.opts);
    assert.equal(ok.ok,true);assert.equal(ok.independentlyReviewed,true);assert.equal(ok.sha,SHA);
    assert.deepEqual(ok.suites,REQUIRED.production);
    const dev=verifyEvidence({...f.opts,mode:'development',reviewFile:undefined});
    assert.equal(dev.independentlyReviewed,false);
  }finally{f.close();}
});
test('refuse wrong source SHA, author and unknown mode',()=>{
 const f=fixtures();try{
  for(const change of [{sha:OTHER_SHA},{author:'other-author'},{mode:'relaxed'}])
   assert.throws(()=>verifyEvidence({...f.opts,...change}));
 }finally{f.close();}
});
test('reject forged CI signature and swapped trusted issuer',()=>{
 const f=fixtures();try{
  const tampered=JSON.parse(fs.readFileSync(f.ciFile,'utf8'));
  tampered.payload.issuer='malicious-bot';
  fs.writeFileSync(f.ciFile,JSON.stringify(tampered));
  assert.throws(()=>verifyEvidence(f.opts),/signature is invalid/);
  f.persist();f.ci.issuer='malicious-bot';f.persist();
  assert.throws(()=>verifyEvidence(f.opts),/identity\/commit/);
 }finally{f.close();}
});
test('reject missing, failing, repeated or stale CI suite evidence',()=>{
 for(const mutate of [
  f=>f.ci.suites.pop(),
  f=>{f.ci.suites[0].exitCode=1;},
  f=>f.ci.suites.push({...f.ci.suites[0]}),
  f=>{f.ci.issuedAt=new Date(f.opts.now-8*24*3600*1000).toISOString();}
 ]){
  const f=fixtures();try{mutate(f);f.persist();assert.throws(()=>verifyEvidence(f.opts));}
  finally{f.close();}
 }
});
test('reject tampered or missing raw log, and symlinked receipts',()=>{
 const f=fixtures();try{
  fs.appendFileSync(path.join(f.logs,'syntax.log'),'tampered');
  assert.throws(()=>verifyEvidence(f.opts),/digest mismatch/);
  f.persist();
  fs.renameSync(f.ciFile,f.ciFile+'.raw');
  fs.symlinkSync(f.ciFile+'.raw',f.ciFile);
  assert.throws(()=>verifyEvidence(f.opts),/Invalid or symlinked/);
 }finally{f.close();}
});
test('reject self-approval, wrong reviewer, stale review or mismatched CI receipt',()=>{
 for(const mutate of [
  f=>{f.review.reviewer='change-author';},
  f=>{f.review.reviewer='untrusted-reviewer';},
  f=>{f.review.decision='commented';},
  f=>{f.review.issuedAt=new Date(f.opts.now-60000).toISOString();},
  f=>{f.review.ciSha256='0'.repeat(64);}
 ]){
  const f=fixtures();try{
   mutate(f);const badDigest=f.review.ciSha256==='0'.repeat(64);f.persist();
   if(badDigest){
     const review=JSON.parse(fs.readFileSync(f.reviewFile,'utf8'));
     review.payload.ciSha256='0'.repeat(64);
     review.signature=crypto.sign(null,signedMessage(review),f.reviewKeys.privateKey).toString('base64');
     fs.writeFileSync(f.reviewFile,JSON.stringify(review));
   }
   assert.throws(()=>verifyEvidence(f.opts));
  }finally{f.close();}
 }
});
test('reject identical release and CI signing principals and wrong trust root',()=>{
 const f=fixtures();try{
  f.trust.review.publicKeyPem=f.trust.ci.publicKeyPem;f.persist();
  assert.throws(()=>verifyEvidence(f.opts),/independent signing keys/);
  f.trust.review.publicKeyPem=f.reviewKeys.publicKey.export({type:'spki',format:'pem'});
  f.trust.repository='other/private-project';f.persist();
  assert.throws(()=>verifyEvidence(f.opts),/Trust repository mismatch/);
 }finally{f.close();}
});
test('release trust root must not be group/world writable',()=>{
 const f=fixtures();try{
  fs.chmodSync(f.trustFile,0o666);
  assert.throws(()=>verifyEvidence(f.opts),/not writable by group\/other/);
 }finally{f.close();}
});
test('production CLI cannot select a PR-supplied trust root',()=>{
 const f=fixtures();try{
  assert.throws(()=>main(['verify','--trust',f.trustFile,'--ci',f.ciFile,'--review',f.reviewFile,
    '--logs',f.logs,'--sha',SHA,'--author','change-author','--mode','production']),
    e=>e.code==='ETRUSTPATH');
 }finally{f.close();}
});

test('multi-GitLab production additionally requires the real multi-offline suite',()=>{
 const f=fixtures();try{
  assert.throws(()=>verifyEvidence({...f.opts,mode:'production-multi'}),/Required suite missing: multi-offline/);
 }finally{f.close();}
});

test('development CLI cannot issue a verified status with a self-selected public key',()=>{
 const f=fixtures();try{
  assert.throws(()=>main(['verify','--trust',f.trustFile,'--ci',f.ciFile,
    '--logs',f.logs,'--sha',SHA,'--author','change-author','--mode','development']),
    error=>error.code==='ETRUSTPATH');
 }finally{f.close();}
});
test('CI author cannot self-attest by reusing a trusted runner or issuer name',()=>{
 for(const mutate of [
  f=>{f.ci.issuer='change-author';f.trust.ci.allowedIdentities.push('change-author');},
  f=>{f.ci.runner='change-author';f.trust.ci.allowedRunners.push('change-author');}
 ]){
  const f=fixtures();try{
   mutate(f);f.persist();
   assert.throws(()=>verifyEvidence(f.opts),/identity\/commit/);
  }finally{f.close();}
 }
});
test('signed raw log must be a regular file, not a symlink to otherwise matching bytes',()=>{
 const f=fixtures();try{
  const log=path.join(f.logs,'syntax.log'),source=path.join(f.root,'old-syntax.log');
  fs.renameSync(log,source);fs.symlinkSync(source,log);
  assert.throws(()=>verifyEvidence(f.opts),/Log must be present/);
 }finally{f.close();}
});
