#!/usr/bin/env node
'use strict';
// One authenticated Release workflow run may publish or perform a no-op.
// Only a real publisher job success permits downstream immutable verification.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const SHA=/^[0-9a-f]{40}$/;
const RUN=/^[1-9][0-9]{0,18}$/;
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+$/;
const PUBLISHER='Package / OCI / attest / publish';
const PREPARE='Prepare release';
function fail(code,message){const error=new Error(message);error.code=code;throw error;}
function assertRun({repository,runId,attempt,headSha,event}){
  if(repository!=='jiying2007/codex-review-service'||!RUN.test(String(runId||''))||
    !RUN.test(String(attempt||''))||!SHA.test(String(headSha||''))||
    !['push','workflow_dispatch','issue_comment'].includes(event))
    fail('ERELEASEIDENTITY','Invalid trusted source release identity');
}
function assessJobs(jobs){
  if(!Array.isArray(jobs)||jobs.length===0||jobs.length>300)
    fail('ERELEASEJOBS','Missing or unbounded Release job evidence');
  const named=name=>jobs.filter(j=>j&&j.name===name);
  const prepared=named(PREPARE),published=named(PUBLISHER);
  if(prepared.length!==1||published.length!==1)
    fail('ERELEASEJOBS','Ambiguous or missing Release jobs');
  const ready=prepared[0].conclusion,done=published[0].conclusion;
  if(ready==='skipped'&&done==='skipped')return{intentRequired:false,published:false};
  if(ready!=='success'||!['success','skipped'].includes(done))
    fail('ERELEASEJOBS','Release job state is not admissible');
  if(done==='success'){
    if(!Array.isArray(published[0].steps)||!published[0].steps.some(step=>
      step.name==='Publish immutable GitHub Release'&&step.conclusion==='success'))
      fail('ERELEASEJOBS','Publisher success lacks verified publication step');
  }
  return{intentRequired:true,published:done==='success'};
}
function validatedIntent(value,context,jobState){
  assertRun(context);
  if(!jobState.intentRequired)return{published:false,releaseSha:null};
  const fields=['schemaVersion','repository','runId','runAttempt','headSha','event','releaseSha','tag','version','publish'];
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).sort().join('|')!==fields.sort().join('|')||value.schemaVersion!==1||
    value.repository!==context.repository||String(value.runId)!==String(context.runId)||
    String(value.runAttempt)!==String(context.attempt)||value.headSha!==context.headSha||
    value.event!==context.event||!SHA.test(value.releaseSha||'')||
    !TAG.test(value.tag||'')||value.tag!=='v'+value.version||
    typeof value.publish!=='boolean'||value.publish!==jobState.published)
    fail('ERELEASEINTENT','Release intent differs from authenticated job evidence');
  if(context.event!=='issue_comment'&&value.releaseSha!==context.headSha)
    fail('ERELEASEINTENT','Normal Release SHA differs from source workflow HEAD');
  return{published:value.publish,releaseSha:value.publish?value.releaseSha:null};
}
function writeIntent(output,env=process.env){
  const context={repository:env.GITHUB_REPOSITORY,runId:env.GITHUB_RUN_ID,
    attempt:env.GITHUB_RUN_ATTEMPT,headSha:env.GITHUB_SHA,event:env.GITHUB_EVENT_NAME};
  assertRun(context);
  const publish=env.RELEASE_PUBLISH==='true';
  if(!['true','false'].includes(env.RELEASE_PUBLISH)||!SHA.test(env.RELEASE_SHA||'')||
    !TAG.test(env.RELEASE_TAG||'')||env.RELEASE_TAG!=='v'+env.RELEASE_VERSION||
    (context.event!=='issue_comment'&&env.RELEASE_SHA!==context.headSha))
    fail('ERELEASEINTENT','Invalid source Release decision');
  if(!path.isAbsolute(output))fail('ERELEASEINTENT','Release intent output must be absolute');
  const item={schemaVersion:1,repository:context.repository,runId:Number(context.runId),
    runAttempt:Number(context.attempt),headSha:context.headSha,event:context.event,
    releaseSha:env.RELEASE_SHA,tag:env.RELEASE_TAG,version:env.RELEASE_VERSION,publish};
  fs.writeFileSync(output,JSON.stringify(item)+'\n',{flag:'wx',mode:0o600});
  return item;
}
function gh(args){
  const output=execFileSync('gh',args,{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,
    env:{...process.env,GH_PROMPT_DISABLED:'1'}});
  return JSON.parse(output);
}
function allJobs(repository,runId){
  const jobs=[];
  for(let page=1;page<=3;page++){
    const response=gh(['api',`repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`]);
    if(!Array.isArray(response?.jobs)||!Number.isSafeInteger(response?.total_count)||
      response.total_count>300)fail('ERELEASEJOBS','Malformed or unbounded Release job listing');
    jobs.push(...response.jobs);
    if(jobs.length>=response.total_count)break;
  }
  return jobs;
}
function readIntent(file){
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0||stat.size>8192)
    fail('ERELEASEINTENT','Missing or unsafe source Release intent artifact');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}
function verifyParent(env=process.env){
  const context={repository:env.GITHUB_REPOSITORY,runId:env.PARENT_RUN_ID,
    attempt:env.PARENT_ATTEMPT,headSha:env.PARENT_HEAD_SHA,event:env.PARENT_EVENT};
  assertRun(context);
  const state=assessJobs(allJobs(context.repository,context.runId));
  if(!state.intentRequired)return{published:false,releaseSha:null};
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'release-intent-'));
  try{
    const name=`release-intent-${context.runId}-${context.attempt}`;
    execFileSync('gh',['run','download',String(context.runId),'--repo',context.repository,
      '--name',name,'--dir',directory],{timeout:45000,encoding:'utf8',maxBuffer:1024*1024,
      env:{...process.env,GH_PROMPT_DISABLED:'1'}});
    return validatedIntent(readIntent(path.join(directory,'release-intent.json')),context,state);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
}
function main(){
  const command=process.argv[2];
  if(command==='write'){
    if(process.argv.length!==4)fail('ERELEASEARGS','Expected one output path');
    const record=writeIntent(process.argv[3]);
    process.stdout.write(JSON.stringify({recorded:true,publish:record.publish})+'\n');
  }else if(command==='verify'){
    const result=verifyParent();
    if(!process.env.GITHUB_OUTPUT)fail('ERELEASEARGS','GitHub output path missing');
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `published=${result.published}\nrelease_sha=${result.releaseSha||''}\n`);
    process.stdout.write(JSON.stringify(result)+'\n');
  }else fail('ERELEASEARGS','Unknown release intent command');
}
if(require.main===module){try{main();}catch(error){
  console.error(String(error.code||'ERELEASEUNKNOWN')+': '+error.message);
  process.exitCode=2;
}}
module.exports={assertRun,assessJobs,validatedIntent,writeIntent,verifyParent};
