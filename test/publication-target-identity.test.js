'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Publisher}=require('../src/publication');
const shaA='a'.repeat(40),shaB='b'.repeat(40),shaC='c'.repeat(40);
const base={iid:9,project_id:7,source_project_id:7,target_project_id:7,state:'opened',draft:false,
  source_branch:'feature',target_branch:'main',sha:shaA,diff_refs:{head_sha:shaA,start_sha:shaB,base_sha:shaC}};
const frozen={snapshotIdentityVersion:1,headSha:shaA,startSha:shaB,baseSha:shaC,
  sourceBranch:'feature',targetBranch:'main',sourceProjectId:7,targetProjectId:7};
function fixture(remote=base){
 let getCount=0;
 const client={getMergeRequest:async()=>{getCount++;return remote;}};
 const publisher=new Publisher({config:{reviewDraftMergeRequests:false},store:{},gitlab:client,logger:{}});
 return{publisher,reads:()=>getCount,item:{project_id:7,mr_iid:9,payload:{...frozen}}};
}
test('new publication actions bind all MR source/target identities',async()=>{
 const v=fixture();
 assert.equal(await v.publisher.currentSnapshot(v.item),true);
 assert.equal(v.reads(),1);
});
test('same-head GitLab retarget and base ref change cancel publication',async()=>{
 const changes=[
  {target_branch:'release'},{source_branch:'other'},{source_project_id:8},{target_project_id:8},
  {diff_refs:{...base.diff_refs,base_sha:'d'.repeat(40)}},
  {diff_refs:{...base.diff_refs,start_sha:'d'.repeat(40)}},
  {diff_refs:{...base.diff_refs,head_sha:'d'.repeat(40)}},
  {sha:'d'.repeat(40)},{iid:10},{state:'merged'},{draft:true}
 ];
 for(const changed of changes){
  const f=fixture({...base,...changed});
  assert.equal(await f.publisher.currentSnapshot(f.item),false,JSON.stringify(changed));
 }
});
test('incomplete new identity never sends a GitLab GET or implies current snapshot',async()=>{
 for(const key of ['headSha','startSha','baseSha','sourceBranch','targetBranch','sourceProjectId','targetProjectId']){
  const f=fixture();
  delete f.item.payload[key];
  assert.equal(await f.publisher.currentSnapshot(f.item),false,key);
  assert.equal(f.reads(),0,key);
 }
});
test('historical unversioned publication remains explicitly outside the new target-bound protocol',async()=>{
 const f=fixture({...base,target_branch:'release'});
 const item={...f.item,payload:{headSha:shaA,startSha:shaB}};
 // These old rows need separate migration/fencing; they are not evidence of
 // target-bound authorization and must never become a merge permission.
 assert.equal(await f.publisher.currentSnapshot(item),true);
 assert.equal(item.payload.snapshotIdentityVersion,undefined);
});

test('unsupported or partial versioned snapshot identity cannot fall into legacy path',async()=>{
 for(const mutate of [
  p=>{p.snapshotIdentityVersion=2;},
  p=>{p.snapshotIdentityVersion='1';},
  p=>{delete p.snapshotIdentityVersion;}
 ]){
  const f=fixture();
  mutate(f.item.payload);
  assert.equal(await f.publisher.currentSnapshot(f.item),false);
  assert.equal(f.reads(),0);
 }
});

test('new actions reject malformed SHA widths and stringified project identifiers',async()=>{
 const invalid=[
  ['headSha','a'.repeat(39)],['startSha','b'.repeat(64)],
  ['baseSha','not-a-sha'],['sourceProjectId','7'],['targetProjectId','7'],
  ['sourceProjectId',0],['targetProjectId',NaN],['sourceBranch',0],
  ['targetBranch',null],['targetBranch','a'.repeat(1025)]
 ];
 for(const [key,value] of invalid){
  const f=fixture();
  f.item.payload[key]=value;
  assert.equal(await f.publisher.currentSnapshot(f.item),false,key);
  assert.equal(f.reads(),0,key);
 }
});

test('stripping protocol version and target branch cannot downgrade a new action',async()=>{
 const f=fixture();
 delete f.item.payload.snapshotIdentityVersion;
 delete f.item.payload.targetBranch;
 assert.equal(await f.publisher.currentSnapshot(f.item),false);
 assert.equal(f.reads(),0);
});

test('invalid outbox payload shape is rejected without contacting GitLab',async()=>{
 for(const value of [null,'text',42,[],true]){
  const f=fixture();f.item.payload=value;
  assert.equal(await f.publisher.currentSnapshot(f.item),false);
  assert.equal(f.reads(),0);
 }
});

test('legacy action without complete head and start SHAs cannot bypass MR verification',async()=>{
 for(const payload of [{},{headSha:shaA},{startSha:shaB},{headSha:'',startSha:''}]){
  const f=fixture();
  f.item.payload=payload;
  assert.equal(await f.publisher.currentSnapshot(f.item),false);
  assert.equal(f.reads(),0,'identity-incomplete payload must not call GitLab');
 }
});

test('discussion resolution rechecks MR after fetching the discussion and rejects a retarget',async()=>{
 const changed={...base};
 let reads=0,writes=0;
 const finding={claimState:'known',claimFingerprint:'c'.repeat(64),fingerprint:'d'.repeat(64)};
 const client={
  getMergeRequest:async()=>{reads++;return {...changed};},
  getDiscussion:async()=>{
   changed.target_branch='release';
   return {id:'discussion',notes:[{id:11,resolvable:true,resolved:false,
      author:{username:'bot'},body:'<!-- codex-review-service:finding:'+finding.fingerprint+' -->'}]};
  },
  setDiscussionResolved:async()=>{writes++;}
 };
 const publisher=new Publisher({config:{reviewDraftMergeRequests:false,botUsername:'bot'},store:{},gitlab:client,logger:{}});
 const result=await publisher.resolveDiscussion({project_id:7,mr_iid:9,payload:{...frozen,discussionId:'discussion',finding}});
 assert.equal(result.cancelled,true);
 assert.equal(result.reason,'stale_snapshot');
 assert.equal(reads,2);
 assert.equal(writes,0,'retargeted MR must not have its discussion resolved');
});
