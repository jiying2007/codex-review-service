#!/usr/bin/env node
'use strict';
// Release-only admission: an immutable product may publish only after the
// canonical main CI Gate ran and passed at the *same* exact source SHA.
// PR CI, named statuses, unsigned receipts, or a failed/queued run never qualify.
const {execFileSync}=require('node:child_process');
const SHA=/^[0-9a-f]{40}$/;
const REPO='jiying2007/codex-review-service';
function deny(code,message){const error=new Error(message);error.code=code;throw error;}
function requireIdentity({repository,sha,event}){
  if(repository!==REPO||typeof sha!=='string'||!SHA.test(sha)||
    !['push','workflow_dispatch','issue_comment'].includes(event))
    deny('ERELEASEIDENTITY','Canonical publisher repo, event and exact SHA required');
}
function pickRun(runs,sha){
  if(!Array.isArray(runs))deny('ECIRUN','Invalid CI workflow response');
  const matching=runs.filter(r=>r?.head_sha===sha&&r?.head_branch==='main'&&r?.event==='push');
  if(!matching.length)return null;
  matching.sort((a,b)=>Number(b.id||0)-Number(a.id||0));
  return matching[0];
}
function assessGate(run,jobs,sha){
  if(!run||run.head_sha!==sha||run.head_branch!=='main'||run.event!=='push'||
     run.status!=='completed'||run.conclusion!=='success')
    deny('ECIGATE','No successful completed same-SHA main CI');
  if(!Array.isArray(jobs)||!jobs.length||jobs.length>300)deny('ECIGATE','Invalid CI job listing');
  const gate=jobs.filter(j=>j?.name==='CI Gate');
  if(gate.length!==1||gate[0].status!=='completed'||gate[0].conclusion!=='success'||
     !Array.isArray(gate[0].steps)||!gate[0].steps.some(s=>
       s.conclusion==='success'&&s.name==='Require applicable development or main-qualification dependencies'))
    deny('ECIGATE','Real canonical main CI Gate steps did not succeed');
  return{sha,runId:run.id,attempt:run.run_attempt,ciGate:'success'};
}
function gh(uri){
  let output;
  try{
    output=execFileSync('gh',['api',uri],{
      encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024,
      env:{...process.env,GH_PROMPT_DISABLED:'1'}
    });
  }catch{deny('EGITHUBAPI','Unable to verify authenticated GitHub CI state');}
  try{return JSON.parse(output);}catch{deny('EGITHUBAPI','GitHub CI state is not valid JSON');}
}
function getJobs(runId){
  const jobs=[];
  for(let page=1;page<=3;page++){
    const r=gh('repos/'+REPO+'/actions/runs/'+runId+'/jobs?filter=latest&per_page=100&page='+page);
    if(!Array.isArray(r?.jobs)||!Number.isSafeInteger(r.total_count)||r.total_count<1||r.total_count>300)
      deny('EGITHUBAPI','Malformed main CI job listing');
    jobs.push(...r.jobs);
    if(jobs.length>=r.total_count)break;
  }
  return jobs;
}
async function main(env=process.env,{api=gh,sleep=ms=>new Promise(r=>setTimeout(r,ms)),limit=150,interval=10000}={}){
  const identity={repository:env.GITHUB_REPOSITORY,sha:env.RELEASE_SHA,event:env.GITHUB_EVENT_NAME};
  requireIdentity(identity);
  if(env.GITHUB_EVENT_NAME!=='issue_comment'){
    const mainRef=api('repos/'+REPO+'/git/ref/heads/main');
    if(mainRef?.object?.sha!==identity.sha)
      deny('ERELEASEDRIFT','Main advanced after source Release decision; stale publication refused');
  }
  if(!Number.isSafeInteger(limit)||limit<1||limit>150||
     !Number.isSafeInteger(interval)||interval<0||interval>30000)
    deny('EOPTIONS','Invalid bounded CI wait options');
  for(let attempt=1;attempt<=limit;attempt++){
    let selected=null;
    for(let page=1;page<=4;page++){
      const result=api('repos/'+REPO+'/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100&page='+page);
      if(!Array.isArray(result?.workflow_runs)||!Number.isSafeInteger(result.total_count))
        deny('EGITHUBAPI','Malformed main CI runs');
      const run=pickRun(result.workflow_runs,identity.sha);
      if(run){selected=run;break;}
      if(result.workflow_runs.length<100)break;
    }
    if(selected?.status==='completed'){
      if(selected.conclusion!=='success')deny('ECIGATE','Same-SHA main CI failed or was cancelled');
      const evidence=assessGate(selected,getJobs(selected.id),identity.sha);
      process.stdout.write(JSON.stringify({ok:true,source:'main-CI',...evidence})+'\n');
      return evidence;
    }
    if(attempt<limit)await sleep(interval);
  }
  deny('ECITIMEOUT','Same-SHA main CI Gate did not complete within bounded release wait');
}
if(require.main===module)main().catch(error=>{
  console.error(String(error.code||'ECIGATE')+': '+error.message);
  process.exitCode=2;
});
module.exports={requireIdentity,pickRun,assessGate,main};
