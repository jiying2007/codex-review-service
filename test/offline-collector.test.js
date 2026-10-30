'use strict';
const test=require('node:test');
const posixTest=process.platform==='win32'?test.skip:test;
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {collect,noSecrets}=require('../scripts/collect-offline-ci');
const {sign,signReview,safeSecret}=require('../scripts/sign-offline-evidence');
const {digest}=require('../scripts/offline-evidence');
function cmd(dir,...argv){const r=spawnSync('git',['-C',dir,...argv],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim();}
function repo(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'offline-ci-source-'));
 cmd(dir,'init');cmd(dir,'config','user.email','ci@example.invalid');cmd(dir,'config','user.name','CI fixture');
 fs.mkdirSync(path.join(dir,'scripts'));
 fs.writeFileSync(path.join(dir,'scripts/check-syntax.js'),"console.log('offline syntax check executed')\n");
 cmd(dir,'add','.');cmd(dir,'commit','-m','seed');
 return{dir,sha:cmd(dir,'rev-parse','HEAD'),close:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('real isolated process creates measured unsigned log; no signing key can be inherited',()=>{
 const f=repo(),out=fs.mkdtempSync(path.join(os.tmpdir(),'offline-ci-results-'));
 try{
  const result=collect({repoDir:f.dir,outDir:out,sha:f.sha,author:'author',issuer:'ci-agent',runner:'isolated-runner',suiteIds:['syntax']});
  assert.equal(result.ok,true);
  const unsigned=JSON.parse(fs.readFileSync(path.join(out,'ci.unsigned.json'),'utf8'));
  assert.equal(unsigned.sha,f.sha);
  assert.equal(unsigned.kind,'ci');
  assert.equal(unsigned.suites[0].exitCode,0);
  assert.match(fs.readFileSync(path.join(out,'logs/syntax.log'),'utf8'),/offline syntax check executed/);
  assert.equal(unsigned.suites[0].logSha256,digest(fs.readFileSync(path.join(out,'logs/syntax.log'))));
  assert.throws(()=>collect({repoDir:f.dir,outDir:out,sha:f.sha,author:'author',issuer:'ci-agent',runner:'isolated-runner',suiteIds:['codex-cloud']}),/hardcoded offline/);
  assert.throws(()=>collect({repoDir:f.dir,outDir:out,sha:'f'.repeat(40),author:'author',issuer:'ci-agent',runner:'isolated-runner',suiteIds:['syntax']}),/not checked out/);
  const env=noSecrets({PATH:process.env.PATH,GITLAB_API_TOKEN:'no',OPENAI_API_KEY:'no',GH_TOKEN:'no'});
  assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.GITLAB_API_TOKEN,undefined);
  assert.equal(env.GH_TOKEN,undefined);assert.equal(env.CODEX_OFFLINE_EVIDENCE,'1');
 }finally{f.close();fs.rmSync(out,{recursive:true,force:true});}
});
posixTest('operator can sign measured evidence with independent keys; self-signing and weak private-key modes fail',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'offline-sign-'));
 try{
  const ci=crypto.generateKeyPairSync('ed25519'),review=crypto.generateKeyPairSync('ed25519');
  const ciPath=path.join(base,'ci-private.pem'),reviewPath=path.join(base,'review-private.pem');
  fs.writeFileSync(ciPath,ci.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  fs.writeFileSync(reviewPath,review.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  const receipt=sign({schemaVersion:1,kind:'ci',sha:'a'.repeat(40),author:'change-author'},'ci-agent',ciPath);
  assert.equal(receipt.payload.kind,'ci');
  const ciFile=path.join(base,'ci.json');fs.writeFileSync(ciFile,JSON.stringify(receipt));
  const reviewReceipt=signReview({ciFile,sha:'a'.repeat(40),author:'change-author',reviewer:'reviewer',keyId:'reviewer-key',privateKeyFile:reviewPath});
  assert.equal(reviewReceipt.payload.ciSha256,digest(fs.readFileSync(ciFile)));
  assert.throws(()=>signReview({ciFile,sha:'a'.repeat(40),author:'reviewer',reviewer:'reviewer',keyId:'reviewer-key',privateKeyFile:reviewPath}),/Independent reviewer/);
  fs.chmodSync(ciPath,0o644);
  assert.throws(()=>safeSecret(ciPath),/0600/);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});

test('evidence output cannot overwrite an older receipt or follow an alias into the checkout',()=>{
 const f=repo(),out=fs.mkdtempSync(path.join(os.tmpdir(),'offline-ci-immutable-'));
 try{
  const opts={repoDir:f.dir,outDir:out,sha:f.sha,author:'author',
    issuer:'ci-agent',runner:'isolated-runner',suiteIds:['syntax']};
  assert.equal(collect(opts).ok,true);
  const original=fs.readFileSync(path.join(out,'ci.unsigned.json'),'utf8');
  assert.throws(()=>collect(opts),/fresh, empty/);
  assert.equal(fs.readFileSync(path.join(out,'ci.unsigned.json'),'utf8'),original);
  if(process.platform!=='win32'){
    const alias=path.join(path.dirname(out),'alias-'+path.basename(out));
    try{
      fs.symlinkSync(out,alias,'dir');
      assert.throws(()=>collect({...opts,outDir:alias}),/real directory/);
    }finally{fs.rmSync(alias,{force:true});}
  }
 }finally{f.close();fs.rmSync(out,{recursive:true,force:true});}
});
test('an uninitialized Core submodule cannot be signed as a clean product checkout',()=>{
 const f=repo(),out=fs.mkdtempSync(path.join(os.tmpdir(),'offline-ci-submodule-'));
 try{
  const mock=(program,args,options)=>{
    if(program==='git'&&args.includes('submodule')&&args.includes('status')){
      return{status:0,stdout:'-190651770a444b0693d82228afc66879dd57b0c0 src/codex-safe-core\n'};
    }
    return spawnSync(program,args,options);
  };
  assert.throws(()=>collect({repoDir:f.dir,outDir:out,sha:f.sha,
    author:'author',issuer:'ci-agent',runner:'isolated-runner',suiteIds:['syntax'],spawn:mock}),
    /uninitialized or changed submodule/);
 }finally{f.close();fs.rmSync(out,{recursive:true,force:true});}
});
