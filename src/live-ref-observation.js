'use strict';

// This is a one-time, read-only observation. It is NOT an atomic merge gate.
// Only an integrated protected-ref transaction can authorize an actual merge.
const SHA=/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function assessLiveMergeRequest(local,remote,{observedAt=new Date().toISOString()}={}){
 const reasons=new Set(),source=local?.source,refs=remote?.diff_refs;
 const result={schemaVersion:1,purpose:'live-ref-observation',mergeAuthorized:false,refTransactionBound:false,
  decision:'blocked',observedAt,localDecision:local?.decision||'missing',reasons:[],
  observed:{projectId:null,mrIid:null,state:null,sourceBranch:null,targetBranch:null,headSha:null,startSha:null,baseSha:null}};
 if(local?.decision!=='evidence_complete_unbound')reasons.add('local_publication_not_complete');
 if(!source||!SHA.test(String(source.headSha||''))||!SHA.test(String(source.startSha||''))||!SHA.test(String(source.baseSha||''))||typeof source.ref!=='string'||!source.ref)reasons.add('local_source_identity_missing');
 if(typeof source?.targetBranch!=='string'||!source.targetBranch)reasons.add('target_branch_unbound');
 if(!remote||typeof remote!=='object'||Array.isArray(remote))reasons.add('remote_merge_request_missing');
 else{
  const validId=value=>Number.isSafeInteger(value)&&value>0;
  if(!validId(remote.iid)||remote.iid!==local?.mrIid)reasons.add('mr_iid_mismatch');
  if(!validId(remote.target_project_id)||remote.target_project_id!==local?.projectId)reasons.add('target_project_mismatch');
  if(!validId(remote.source_project_id)||remote.source_project_id!==source?.statusProjectId)reasons.add('source_project_mismatch');
  if(remote.state!=='opened'||remote.draft===true||remote.work_in_progress===true)reasons.add('mr_not_mergeable_state');
  if(typeof remote.source_branch!=='string'||remote.source_branch!==source?.ref)reasons.add('source_branch_mismatch');
  if(typeof remote.target_branch!=='string'||!remote.target_branch)reasons.add('target_branch_unavailable');
  // This generation of local review_jobs stores the source branch but not the
  // reviewed target branch. Never treat a merely nonempty remote target as
  // evidence that the original merge target was unchanged.
  if(typeof source?.targetBranch==='string'&&source.targetBranch&&remote.target_branch!==source.targetBranch)reasons.add('target_branch_mismatch');
  if(!refs||typeof refs!=='object')reasons.add('current_diff_refs_missing');
  else{
   if(!SHA.test(String(refs.head_sha||''))||refs.head_sha!==source?.headSha)reasons.add('head_sha_changed');
   if(!SHA.test(String(refs.start_sha||''))||refs.start_sha!==source?.startSha)reasons.add('start_sha_changed');
   if(!SHA.test(String(refs.base_sha||''))||refs.base_sha!==source?.baseSha)reasons.add('base_sha_changed');
  }
  if(remote.sha!==undefined&&(!SHA.test(String(remote.sha||''))||remote.sha!==source?.headSha))reasons.add('mr_head_sha_changed');
  result.observed={projectId:validId(remote.target_project_id)?remote.target_project_id:null,
   mrIid:validId(remote.iid)?remote.iid:null,state:remote.state==='opened'?'opened':'not_open',
   sourceBranch:typeof remote.source_branch==='string'?remote.source_branch:null,
   targetBranch:typeof remote.target_branch==='string'?remote.target_branch:null,
   headSha:SHA.test(String(refs?.head_sha||''))?refs.head_sha:null,
   startSha:SHA.test(String(refs?.start_sha||''))?refs.start_sha:null,
   baseSha:SHA.test(String(refs?.base_sha||''))?refs.base_sha:null};
 }
 result.reasons=[...reasons];
 if(!reasons.size)result.decision='observed_current_unbound';
 return Object.freeze(result);
}
module.exports={assessLiveMergeRequest};
