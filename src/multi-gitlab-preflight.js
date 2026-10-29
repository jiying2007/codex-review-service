'use strict';

// Credential-safe, READ-ONLY GitLab acceptance preflight. This module does
// not start Service workers, use Codex, publish statuses or process webhooks.
const fs=require('node:fs');
const {loadMultiManifest}=require('./multi-gitlab-config');
const {readSecretFile}=require('./secrets');
const {contract}=require('./product-contract');

async function checkResponse(url,token,{fetchImpl=fetch,timeoutMs=8000}={}){
  const response=await fetchImpl(url,{
    method:'GET',
    headers:{'Accept':'application/json','PRIVATE-TOKEN':token},
    redirect:'error',
    signal:AbortSignal.timeout(timeoutMs)
  });
  if(!response?.ok){
    const error=new Error('GitLab API read unavailable: HTTP '+String(response?.status||0));
    error.code='EGITLABREAD';
    throw error;
  }
  return response;
}
async function preflightInstance(instance,{fetchImpl=fetch,timeoutMs=8000}={}){
  const cfg=JSON.parse(fs.readFileSync(instance.configFile,'utf8'));
  const token=readSecretFile(instance.secretFiles.GITLAB_API_TOKEN_FILE,'GITLAB_API_TOKEN');
  const base=instance.origin+'/api/v4';
  const context={fetchImpl,timeoutMs};
  const versionResponse=await checkResponse(base+'/version',token,context);
  const version=await versionResponse.json();
  const value=String(version?.version||'');
  const parts=value.match(/^(\d+)\.(\d+)\.(\d+)/);
  if(!parts){
    const error=new Error('GitLab version is not reported by API');
    error.code='EGITLABVERSION';
    throw error;
  }
  const [major,minor,patch]=parts.slice(1).map(Number);
  if(major<14 || (major===14 && (minor<6 || (minor===6 && patch<1)))){
    const error=new Error('GitLab API version is below minimum compatible 14.6.1');
    error.code='EGITLABVERSION';
    throw error;
  }
  const projects=cfg.gitlab.projects||[];
  for(const id of projects)await checkResponse(base+'/projects/'+encodeURIComponent(id),token,context);
  const groups=cfg.gitlab.groups||[];
  for(const group of groups)await checkResponse(base+'/groups/'+encodeURIComponent(group.id),token,context);
  return {id:instance.id,apiReadable:true,version:value,
    checkedProjects:projects.length,checkedGroups:groups.length,
    // API GETs cannot prove write permissions or webhook direction.
    writePermissionsVerified:false,webhookDeliveryVerified:false};
}
async function runPreflight({manifestFile,fetchImpl=fetch,timeoutMs=8000}={}){
  const manifest=loadMultiManifest(manifestFile);
  const results=[];
  for(const instance of manifest.instances){
    try{results.push(await preflightInstance(instance,{fetchImpl,timeoutMs}));}
    catch(error){results.push({id:instance.id,apiReadable:false,code:String(error.code||'EGITLABREAD').slice(0,80)});}
  }
  return {ok:results.every(item=>item.apiReadable),mode:'read-only',
    noModelInvocations:true,results};
}
if(require.main===module)runPreflight().then(out=>{
  process.stdout.write(JSON.stringify(out,null,2)+'\n');
  if(!out.ok)process.exitCode=2;
}).catch(error=>{
  process.stderr.write(JSON.stringify({ok:false,code:String(error.code||'EMULTICONFIG')})+'\n');
  process.exitCode=2;
});
module.exports={checkResponse,preflightInstance,runPreflight};
