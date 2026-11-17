'use strict';
// Owner-requested metadata preparation only. Never updates main, existing refs,
// tags, releases, protections, or live services. New branches still require PR CI.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const REPOSITORY='jiying2007/codex-review-service';
const VERSION=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA=/^[a-f0-9]{40}$/;
function requestFromEvent(event,env){
  if(env.GITHUB_REPOSITORY!==REPOSITORY||env.GITHUB_ACTOR!==REPOSITORY.split('/')[0])throw new Error('Owner-only release preparation');
  let version,source;
  if(env.GITHUB_EVENT_NAME==='issue_comment'){
    if(event.action!=='created'||event.comment?.author_association!=='OWNER'||event.comment?.user?.login!==env.GITHUB_ACTOR)
      throw new Error('Untrusted release request');
    const match=/^\/prepare-release (\S+) ([a-f0-9]{40})$/.exec(event.comment.body||'');
    if(!match)throw new Error('Expected /prepare-release VERSION EXACT_MAIN_SHA');
    [,version,source]=match;
  }else if(env.GITHUB_EVENT_NAME==='workflow_dispatch'){
    version=event.inputs?.version;source=event.inputs?.source_sha;
  }else throw new Error('Unsupported release preparation event');
  if(typeof version!=='string'||!VERSION.test(version)||!SHA.test(source||''))throw new Error('Invalid release version or source');
  return Object.freeze({version,source});
}
function requireNextPatch(current,next){
  if(!VERSION.test(current)||!VERSION.test(next))throw new Error('Invalid patch transition');
  const before=current.split('.').map(Number),after=next.split('.').map(Number);
  if([...before,...after].some(n=>!Number.isSafeInteger(n))||before[0]!==after[0]||before[1]!==after[1]||after[2]!==before[2]+1)
    throw new Error('Only the next patch release can be prepared');
}
function validateChangedPaths(paths,allowed){
  if(!paths.length||paths.some(p=>!allowed.has(p)))throw new Error('Release preparation changed an unauthorized path');
  for(const required of ['package.json','package-lock.json','product-contract.json','CHANGELOG.md'])
    if(!paths.includes(required))throw new Error('Incomplete release metadata update');
}
function cleanEnv(env){const result={...env};for(const name of ['GH_TOKEN','GITHUB_TOKEN'])delete result[name];return result;}
function run(args){return execFileSync(args[0],args.slice(1),{cwd:root,encoding:'utf8',env:cleanEnv(process.env),maxBuffer:4*1024*1024}).trim();}
async function main(env=process.env){
  const request=requestFromEvent(JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH,'utf8')),env);
  const token=env.GH_TOKEN;if(!token)throw new Error('Workflow token missing');
  async function api(endpoint,body,allow404=false){
    const response=await fetch('https://api.github.com/repos/'+REPOSITORY+endpoint,{
      method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(allow404&&response.status===404)return null;
    if(!response.ok)throw new Error('Release preparation API failed: HTTP '+response.status);
    return response.json();
  }
  const current=JSON.parse(fs.readFileSync(path.join(root,'product-contract.json'),'utf8'));
  requireNextPatch(current.serviceVersion,request.version);
  if(current.productVersion!==current.serviceVersion)throw new Error('Source product identity is inconsistent');
  if(run(['git','rev-parse','HEAD'])!==request.source||run(['git','status','--porcelain']))throw new Error('Exact clean main source required');
  const live=await api('/git/ref/heads/main');
  if(live.object?.sha!==request.source)throw new Error('Main moved; request exact current source again');
  const runs=await api('/actions/runs?head_sha='+request.source+'&per_page=30');
  const ci=runs.workflow_runs?.find(r=>r.name==='CI'&&r.path==='.github/workflows/ci.yml'&&r.head_branch==='main'&&
    r.head_sha===request.source&&['push','workflow_dispatch'].includes(r.event)&&r.status==='completed'&&r.conclusion==='success');
  if(!ci)throw new Error('Same-source completed main CI required');
  if(await api('/releases/tags/v'+request.version,undefined,true))throw new Error('Release already exists');
  const branch='release/service-'+request.version+'-'+request.source.slice(0,12);
  if(await api('/git/ref/heads/'+branch,undefined,true))throw new Error('Preparation branch already exists; inspect it instead of rewriting');
  const notesPath='.github/release-notes/'+request.version+'.md';
  run(['git','ls-files','--error-unmatch',notesPath]);
  const notes=fs.readFileSync(path.join(root,notesPath),'utf8').trim();
  if(!notes||notes.length>16000||notes.includes('Release prepared.')||/^## /m.test(notes))throw new Error('Reviewed release notes are required');
  run([process.execPath,'scripts/release.js','prepare',request.version]);
  const changelog=path.join(root,'CHANGELOG.md');
  const placeholder='- Release prepared. Replace this line with final release notes before merge.';
  const text=fs.readFileSync(changelog,'utf8');
  if(!text.includes(placeholder))throw new Error('Missing release note insertion point');
  fs.writeFileSync(changelog,text.replace(placeholder,notes));
  run([process.execPath,'scripts/generate-contract-docs.js']);
  run(['git','diff','--check']);
  const changed=run(['git','diff','--name-only','-z']).split('\0').filter(Boolean);
  const {CURRENT_DOCS}=require('./sync-operational-docs');
  validateChangedPaths(changed,new Set(['package.json','package-lock.json','product-contract.json','CHANGELOG.md',...CURRENT_DOCS]));
  run([process.execPath,'scripts/verify-product-contract.js']);
  run([process.execPath,'scripts/release.js','verify']);
  const source=await api('/git/commits/'+request.source);
  if(!SHA.test(source.tree?.sha||''))throw new Error('Invalid source tree');
  const entries=changed.map(file=>{
    const stat=fs.lstatSync(path.join(root,file));
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw new Error('Unsafe release metadata file');
    return{path:file,mode:'100644',type:'blob',content:fs.readFileSync(path.join(root,file),'utf8')};
  });
  const tree=await api('/git/trees',{base_tree:source.tree.sha,tree:entries});
  const commit=await api('/git/commits',{message:'release(service): prepare '+request.version+' verified runtime remediation',tree:tree.sha,parents:[request.source]});
  if(!SHA.test(commit.sha||''))throw new Error('Invalid preparation commit');
  if((await api('/git/ref/heads/main')).object?.sha!==request.source)throw new Error('Main moved before branch creation');
  // POST create-ref, not PATCH: an existing/racing branch is never overwritten.
  await api('/git/refs',{ref:'refs/heads/'+branch,sha:commit.sha});
  const receipt={schemaVersion:1,kind:'release_preparation_branch',repository:REPOSITORY,version:request.version,
    sourceSha:request.source,mainCiRunId:ci.id,branch,headSha:commit.sha,changedFiles:changed,
    published:false,merged:false,productionQualified:false};
  fs.writeFileSync('RELEASE_PREPARATION.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify(receipt,null,2)+'\n');return receipt;
}
if(require.main===module)main().catch(error=>{console.error(String(error.message||'Release preparation failed'));process.exitCode=1;});
module.exports={requestFromEvent,requireNextPatch,validateChangedPaths,cleanEnv};
