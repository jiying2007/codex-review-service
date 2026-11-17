'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {requestFromEvent,requireNextPatch,validateChangedPaths,cleanEnv}=require('../scripts/prepare-release-branch');
const source='a'.repeat(40),env={GITHUB_REPOSITORY:'jiying2007/codex-review-service',GITHUB_ACTOR:'jiying2007',GITHUB_EVENT_NAME:'issue_comment'};
const event={action:'created',comment:{author_association:'OWNER',user:{login:'jiying2007'},body:'/prepare-release 8.0.1 '+source}};
test('release preparation accepts only owner exact-source canonical commands',()=>{
 assert.deepEqual(requestFromEvent(event,env),{version:'8.0.1',source});
 for(const body of ['/prepare-release 08.0.1 '+source,'/prepare-release 8.0.1 '+source+'\nsh x','/prepare-release 8.0.1 main'])
  assert.throws(()=>requestFromEvent({...event,comment:{...event.comment,body}},env));
 assert.throws(()=>requestFromEvent(event,{...env,GITHUB_ACTOR:'other'}),/Owner/);
 assert.throws(()=>requestFromEvent({...event,comment:{...event.comment,author_association:'MEMBER'}},env),/Untrusted/);
 assert.throws(()=>requestFromEvent(event,{...env,GITHUB_EVENT_NAME:'pull_request'}),/Unsupported/);
 assert.throws(()=>requestFromEvent(event,{...env,GITHUB_REPOSITORY:'other/repo'}),/Owner/);
});
test('next-patch and metadata allowlist cannot edit runtime or privilege boundaries',()=>{
 requireNextPatch('8.0.0','8.0.1');
 for(const next of ['8.1.0','9.0.0','8.0.0','8.0.2','8.0.999999999999999999999'])assert.throws(()=>requireNextPatch('8.0.0',next));
 const required=['package.json','package-lock.json','product-contract.json','CHANGELOG.md'];
 validateChangedPaths(required,new Set(required));
 assert.throws(()=>validateChangedPaths([...required,'src/index.js'],new Set(required)),/unauthorized/);
 assert.throws(()=>validateChangedPaths(required.slice(1),new Set(required)),/Incomplete/);
 assert.deepEqual(cleanEnv({GH_TOKEN:'private',GITHUB_TOKEN:'private',PATH:'/bin'}),{PATH:'/bin'});
});
test('real prepare command updates both product identities in an isolated copy',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'release-prepare-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'scripts'));
 fs.copyFileSync('scripts/release.js',path.join(dir,'scripts/release.js'));
 for(const file of ['package.json','package-lock.json','product-contract.json','CHANGELOG.md'])fs.copyFileSync(file,path.join(dir,file));
 execFileSync(process.execPath,['scripts/release.js','prepare','8.0.99'],{cwd:dir});
 const contract=JSON.parse(fs.readFileSync(path.join(dir,'product-contract.json'),'utf8'));
 assert.equal(contract.serviceVersion,'8.0.99');assert.equal(contract.productVersion,'8.0.99');
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'package-lock.json'),'utf8')).packages[''].version,'8.0.99');
});
test('preparation uses trusted main, owner admission and create-only refs without merges or PATs',()=>{
 const workflow=fs.readFileSync('.github/workflows/release-prepare.yml','utf8');
 const script=fs.readFileSync('scripts/prepare-release-branch.js','utf8');
 assert.match(workflow,/github.actor == github.repository_owner/);assert.match(workflow,/ref: main/);
 assert.match(workflow,/persist-credentials: false/);assert.doesNotMatch(workflow,/pull_request_target|schedule:|secrets\./);
 assert.match(script,/method:body===undefined\?'GET':'POST'/);
 assert.doesNotMatch(script,/method:.*(?:PATCH|PUT)|force:true|git','push/);
 assert.match(script,/Same-source completed main CI required/);
});
