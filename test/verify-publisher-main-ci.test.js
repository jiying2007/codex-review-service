'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {requireIdentity,pickRun,assessGate,main}=require('../scripts/verify-publisher-main-ci');
const SHA='a'.repeat(40),OLD='b'.repeat(40);
const good={id:42,run_attempt:1,event:'push',head_sha:SHA,head_branch:'main',status:'completed',conclusion:'success'};
const gate={name:'CI Gate',status:'completed',conclusion:'success',
  steps:[{name:'Require applicable development or main-qualification dependencies',conclusion:'success'}]};
const identity={repository:'jiying2007/codex-review-service',sha:SHA,event:'push'};
test('publisher admits only genuine completed same-SHA main push CI Gate',()=>{
  assert.equal(assessGate(good,[gate],SHA).ciGate,'success');
  for(const x of [
    {...good,head_sha:OLD},{...good,head_branch:'feature'},{...good,event:'pull_request'},
    {...good,status:'in_progress'},{...good,conclusion:'failure'}
  ])assert.throws(()=>assessGate(x,[gate],SHA));
});
test('publisher denies forged, skipped or empty CI Gate evidence',()=>{
  for(const jobs of [[],[{...gate,conclusion:'skipped'}],[{...gate,steps:[]}],
    [{...gate,steps:[{name:'Other',conclusion:'success'}]}],[gate,gate]])
    assert.throws(()=>assessGate(good,jobs,SHA));
});
test('selection never reuses a PR run, another SHA or an older failed attempt',()=>{
  const other={...good,id:50,event:'pull_request'};
  assert.deepEqual(pickRun([other,{...good,id:44},good],SHA).id,44);
  assert.equal(pickRun([other],SHA),null);
  assert.equal(pickRun([{...good,head_sha:OLD}],SHA),null);
});
test('publisher requires exact repository, commit and supported run context',()=>{
  assert.doesNotThrow(()=>requireIdentity(identity));
  for(const change of [
    {repository:'other/fork'}, {sha:OLD.slice(1)}, {event:'pull_request'}
  ])assert.throws(()=>requireIdentity({...identity,...change}));
});
test('release cannot publish if main moved after its source decision',async()=>{
  let calls=0;
  await assert.rejects(main({
    GITHUB_REPOSITORY:identity.repository,RELEASE_SHA:SHA,GITHUB_EVENT_NAME:'push'
  },{api:()=>{calls++;return{object:{sha:OLD}};},limit:1,interval:0}),/Main advanced/);
  assert.equal(calls,1);
});
test('completed failing CI stops publication without waiting for more runs',async()=>{
  const env={GITHUB_REPOSITORY:identity.repository,RELEASE_SHA:SHA,GITHUB_EVENT_NAME:'push'};
  let polls=0;
  const api=uri=>{
    if(uri.includes('/git/ref/heads/main'))return{object:{sha:SHA}};
    polls++;
    return{total_count:1,workflow_runs:[{...good,conclusion:'failure'}]};
  };
  await assert.rejects(main(env,{api,limit:3,interval:0}),/CI failed/);
  assert.equal(polls,1);
});
test('missing CI is a bounded deadline, not synthetic success',async()=>{
  const env={GITHUB_REPOSITORY:identity.repository,RELEASE_SHA:SHA,GITHUB_EVENT_NAME:'push'};
  let count=0;
  await assert.rejects(main(env,{api:uri=>{
    if(uri.includes('/git/ref/heads/main'))return{object:{sha:SHA}};
    count++;return{total_count:0,workflow_runs:[]};
  },sleep:async()=>{},limit:3,interval:0}),/did not complete/);
  assert.equal(count,3);
});
