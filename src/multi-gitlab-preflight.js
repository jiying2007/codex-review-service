'use strict';

// Credential-safe, READ-ONLY GitLab acceptance preflight. This module does
// not start Service workers, use Codex, publish statuses or process webhooks.
const {readSecretFile}=require('./secrets');

const MAX_JSON_BYTES=1024*1024;
function readError(code,message){const error=new Error(message);error.code=code;return error;}
async function checkResponse(url,token,{fetchImpl=fetch,timeoutMs=8000,
    readJson=false,maxBytes=MAX_JSON_BYTES}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000||
      !Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_JSON_BYTES)
    throw readError('EGITLABOPTIONS','Invalid bounded preflight read options');
  const controller=new AbortController();
  let response,reader,timer,timedOut=false;
  const cancel=async()=>{
    try{
      if(reader)await reader.cancel();
      else if(response?.body)await response.body.cancel();
    }catch{/* Abort below still closes a failed or already consumed body. */}
    finally{try{reader?.releaseLock();}catch{}}
  };
  const deadline=new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      timedOut=true;
      controller.abort();
      reject(readError('EGITLABTIMEOUT','GitLab API read timed out'));
    },timeoutMs);
  });
  const request=(async()=>{
    response=await fetchImpl(url,{
      method:'GET',
      headers:{'Accept':'application/json','PRIVATE-TOKEN':token},
      redirect:'error',signal:controller.signal
    });
    // A custom transport might settle after the deadline. Never leave its
    // late response open or continue parsing it after the caller has failed.
    if(timedOut){await cancel();throw readError('EGITLABTIMEOUT','GitLab API read timed out');}
    if(!response?.ok){
      await cancel();
      throw readError('EGITLABREAD','GitLab API read unavailable');
    }
    if(!readJson){
      // Project/group probes only need status. Release the body immediately,
      // rather than keeping sockets alive until GC or the request deadline.
      await cancel();
      return response;
    }
    if(!response.body||typeof response.body.getReader!=='function')
      throw readError('EGITLABBODY','GitLab API JSON body is unavailable');
    reader=response.body.getReader();
    const chunks=[];
    let total=0;
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      if(!(value instanceof Uint8Array))
        throw readError('EGITLABBODY','GitLab API JSON body is invalid');
      total+=value.byteLength;
      if(total>maxBytes)throw readError('EGITLABSIZE','GitLab API JSON body exceeds limit');
      chunks.push(Buffer.from(value));
    }
    try{
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,total)));
    }catch{throw readError('EGITLABBODY','GitLab API JSON body is invalid');}
  })();
  try{return await Promise.race([request,deadline]);}
  catch(error){
    if(timedOut)throw readError('EGITLABTIMEOUT','GitLab API read timed out');
    // Even a transport-supplied error with a recognized code must not leak
    // its raw message, URL, credential or response body.
    const messages={EGITLABREAD:'GitLab API read unavailable',
      EGITLABBODY:'GitLab API JSON body is invalid',EGITLABSIZE:'GitLab API JSON body exceeds limit'};
    const code=Object.hasOwn(messages,error?.code)?error.code:'EGITLABREAD';
    throw readError(code,messages[code]);
  }finally{
    clearTimeout(timer);
    controller.abort();
    // Cleanup is best-effort and cannot extend the public request deadline.
    void cancel();
  }
}
async function preflightInstance(instance,{fetchImpl=fetch,timeoutMs=8000}={}){
  // Capture the manifest-validated scope rather than reopen a mutable file.
  const cfg=instance.preflightScope;
  if(!cfg || !Array.isArray(cfg.projects) || !Array.isArray(cfg.groups))
    throw readError('EGITLABSCOPE','Validated preflight scope is missing');
  const token=readSecretFile(instance.secretFiles.GITLAB_API_TOKEN_FILE,'GITLAB_API_TOKEN');
  const base=instance.origin+'/api/v4';
  const context={fetchImpl,timeoutMs};
  // Public projects and /version can return HTTP 200 even if a supplied PAT
  // is invalid. /user requires a real authenticated GitLab identity.
  const identity=await checkResponse(base+'/user',token,{...context,readJson:true});
  if(!Number.isSafeInteger(identity?.id)||identity.id<=0){
    const error=new Error('GitLab API token did not resolve an authenticated user');
    error.code='EGITLABAUTH';
    throw error;
  }
  const version=await checkResponse(base+'/version',token,{...context,readJson:true});
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
  const projects=cfg.projects;
  for(const id of projects)await checkResponse(base+'/projects/'+encodeURIComponent(id),token,context);
  const groups=cfg.groups;
  for(const group of groups)await checkResponse(base+'/groups/'+encodeURIComponent(group.id),token,context);
  return {id:instance.id,apiReadable:true,authenticated:true,version:value,
    checkedProjects:projects.length,checkedGroups:groups.length,
    // API GETs cannot prove write permissions or webhook direction.
    writePermissionsVerified:false,webhookDeliveryVerified:false};
}
async function runPreflight({manifestFile,fetchImpl=fetch,timeoutMs=8000}={}){
  // Keep transport-only probes independent of Service startup dependencies.
  // The CLI still validates the complete manifest before any API request.
  const {loadMultiManifest}=require('./multi-gitlab-config');
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
