'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {assessJobs,validatedIntent,writeIntent}=require('../scripts/release-integrity-admission');
const sha='a'.repeat(40),old='b'.repeat(40);
const context={repository:'jiying2007/codex-review-service',runId:'1234',attempt:'1',headSha:sha,event:'push'};
function jobs(pre='success',post='success',publication='success'){
  return [{name:'Prepare release',conclusion:pre},
    {name:'Package / OCI / attest / publish',conclusion:post,
      steps:[{name:'Publish immutable GitHub Release',conclusion:publication}]}];
}
function intent(overrides={}){return{
  schemaVersion:1,repository:context.repository,runId:1234,runAttempt:1,
  headSha:sha,event:'push',releaseSha:sha,tag:'v7.6.2',version:'7.6.2',publish:true,...overrides
};}
test('successful publisher requires its real final publication step',()=>{
  const state=assessJobs(jobs());assert.deepEqual(state,{intentRequired:true,published:true});
  assert.deepEqual(validatedIntent(intent(),context,state),{published:true,releaseSha:sha});
  assert.throws(()=>assessJobs(jobs('success','success','skipped')),/publication step/);
});
test('no new version is a legitimate no-op only with a matching skipped publisher',()=>{
  const state=assessJobs(jobs('success','skipped'));
  assert.deepEqual(state,{intentRequired:true,published:false});
  assert.deepEqual(validatedIntent(intent({publish:false}),context,state),{published:false,releaseSha:null});
  assert.throws(()=>validatedIntent(intent({publish:true}),context,state),/differs/);
});
test('non-release Issue comment with skipped prepare is safely ignored',()=>{
  assert.deepEqual(assessJobs(jobs('skipped','skipped')),{intentRequired:false,published:false});
  assert.throws(()=>assessJobs(jobs('skipped','success')),/not admissible/);
});
test('ambiguous, missing or broken publisher evidence is denied',()=>{
  assert.throws(()=>assessJobs([jobs()[0]]),/Ambiguous/);
  assert.throws(()=>assessJobs([...jobs(),jobs()[1]]),/Ambiguous/);
  assert.throws(()=>assessJobs(jobs('failed','skipped')),/not admissible/);
  assert.throws(()=>assessJobs(jobs('success','failure')),/not admissible/);
  assert.throws(()=>assessJobs([]),/Missing/);
});
test('intent is bound to repo, parent run, attempt, SHA, tag and decision',()=>{
  for(const mutation of [
    {repository:'someone/fork'}, {runId:1235}, {runAttempt:2}, {headSha:old},
    {releaseSha:old}, {tag:'v7.6.1'}, {schemaVersion:2}, {publish:false}, {extra:'x'}
  ])assert.throws(()=>validatedIntent(intent(mutation),context,assessJobs(jobs())));
});
test('authorized historical release retry may target its immutable tag SHA',()=>{
  const retry={...context,event:'issue_comment'};
  const payload=intent({event:'issue_comment',releaseSha:old});
  assert.equal(validatedIntent(payload,retry,assessJobs(jobs())).releaseSha,old);
  assert.throws(()=>validatedIntent(payload,context,assessJobs(jobs())));
});
test('source release writes a fresh, validated and nonoverwritable intent',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'release-intent-test-'));
  const file=path.join(directory,'out.json');
  const env={GITHUB_REPOSITORY:context.repository,GITHUB_RUN_ID:'1234',
    GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:sha,GITHUB_EVENT_NAME:'push',
    RELEASE_SHA:sha,RELEASE_VERSION:'7.6.2',RELEASE_TAG:'v7.6.2',RELEASE_PUBLISH:'false'};
  try{
    const output=writeIntent(file,env);
    assert.equal(output.publish,false);
    assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),output);
    assert.throws(()=>writeIntent(file,env),/EEXIST/);
    assert.throws(()=>writeIntent(path.join(directory,'bad.json'),{...env,RELEASE_SHA:old}),/differs|Invalid/);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('normal release head mismatch fails closed, and source version schema rejects invalid input',()=>{
  assert.throws(()=>validatedIntent(intent({releaseSha:old}),context,assessJobs(jobs())),/Normal Release/);
  assert.throws(()=>validatedIntent(intent({tag:'bad'}),context,assessJobs(jobs())));
  assert.throws(()=>validatedIntent(intent({runId:0}),context,assessJobs(jobs())));
});
