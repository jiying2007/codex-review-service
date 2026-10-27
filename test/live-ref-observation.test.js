'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assessLiveMergeRequest}=require('../src/live-ref-observation');
const {publicationEvidenceLive}=require('../src/admin');
const headSha='a'.repeat(40),startSha='b'.repeat(40),baseSha='c'.repeat(40);
const api='https://gitlab.example.invalid/api/v4';
const local={schemaVersion:1,decision:'evidence_complete_unbound',projectId:7,mrIid:9,
 source:{gitlabApiUrl:api,statusProjectId:7,ref:'feature',headSha,startSha,baseSha,statusName:'codex-review',pipelineId:42}};
const remote={iid:9,source_project_id:7,target_project_id:7,state:'opened',draft:false,
 source_branch:'feature',target_branch:'main',sha:headSha,
 diff_refs:{head_sha:headSha,start_sha:startSha,base_sha:baseSha}};
test('matching live GitLab refs give only observed-current, never atomic merge authorization',()=>{
 const result=assessLiveMergeRequest(local,remote,{observedAt:'2026-10-27T00:00:00.000Z'});
 assert.equal(result.decision,'observed_current_unbound');
 assert.equal(result.mergeAuthorized,false);
 assert.equal(result.refTransactionBound,false);
 assert.equal(result.purpose,'live-ref-observation');
 assert.deepEqual(result.reasons,[]);
 assert.equal(result.observed.headSha,headSha);
 assert.ok(!JSON.stringify(result).includes('fixture-token'));
});
test('each changed ref or MR project fails closed',()=>{
 for(const [patch,reason] of [
  [{diff_refs:{...remote.diff_refs,head_sha:'d'.repeat(40)}},'head_sha_changed'],
  [{sha:'e'.repeat(40)},'mr_head_sha_changed'],
  [{diff_refs:{...remote.diff_refs,start_sha:'d'.repeat(40)}},'start_sha_changed'],
  [{diff_refs:{...remote.diff_refs,base_sha:'d'.repeat(40)}},'base_sha_changed'],
  [{target_project_id:8},'target_project_mismatch'],
  [{source_project_id:8},'source_project_mismatch'],
  [{source_branch:'other'},'source_branch_mismatch'],
  [{iid:10},'mr_iid_mismatch'],
  [{state:'merged'},'mr_not_mergeable_state'],
  [{draft:true},'mr_not_mergeable_state'],
  [{target_branch:''},'target_branch_unavailable'],
  [{diff_refs:null},'current_diff_refs_missing']]){
  const result=assessLiveMergeRequest(local,{...remote,...patch});
  assert.equal(result.decision,'blocked',reason);
  assert.equal(result.mergeAuthorized,false);
  assert.equal(result.refTransactionBound,false);
  assert.ok(result.reasons.includes(reason),reason+': '+JSON.stringify(result.reasons));
 }
});
test('local missing or uncertain status history cannot be promoted by a matching remote read',()=>{
 const missing=assessLiveMergeRequest({...local,decision:'blocked'},remote);
 assert.equal(missing.decision,'blocked');
 assert.ok(missing.reasons.includes('local_publication_not_complete'));
 const malformed=assessLiveMergeRequest({...local,source:null},remote);
 assert.equal(malformed.decision,'blocked');
 assert.ok(malformed.reasons.includes('local_source_identity_missing'));
});
test('admin live-ref diagnostic uses GET only and cannot issue a merge',async()=>{
 const calls=[],config={gitlabApiUrl:api,gitlabToken:'synthetic',statusName:'codex-review'};
 const clientFactory=cfg=>{assert.equal(cfg,config);return{getMergeRequest:async(p,i)=>{calls.push(['GET',p,i]);return remote;}};};
 const result=await publicationEvidenceLive(7,9,{inspect:()=>local,config,clientFactory});
 assert.deepEqual(calls,[['GET',7,9]]);
 assert.equal(result.decision,'observed_current_unbound');
 assert.equal(result.mergeAuthorized,false);
 assert.equal(result.refTransactionBound,false);
 await assert.rejects(()=>publicationEvidenceLive(7,9,{inspect:()=>local,config:{...config,gitlabApiUrl:'https://foreign.invalid/api/v4'},clientFactory}),error=>error.code==='ECONFIGFILE');
 const blocked=await publicationEvidenceLive(7,9,{inspect:()=>({...local,decision:'blocked'}),config,clientFactory});
 assert.equal(blocked.decision,'blocked');
 assert.deepEqual(calls,[['GET',7,9']],'blocked local evidence must not trigger another remote query');
});
