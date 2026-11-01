#!/usr/bin/env node
'use strict';

// Production-only immutable tag admission. Never overwrite, delete, retarget,
// or treat an unsuccessful GitHub GET's stdout as proof that a tag exists.
const SHA=/^[0-9a-f]{40}$/;
const TAG=/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const REPOSITORY='jiying2007/codex-review-service';
const ORIGIN='https://api.github.com';
const MAX_BODY=64*1024;
function reject(code,message){const e=new Error(message);e.code=code;throw e;}
function identity({repository,tag,sha,token}){
  if(repository!==REPOSITORY||!TAG.test(String(tag||''))||
      !SHA.test(String(sha||''))||!String(token||'').trim())
    reject('ETAGINPUT','Invalid repository, release tag, SHA or protected token');
}
async function getJson(response){
  if(!response.body||typeof response.body.getReader!=='function')
    reject('ETAGJSON','GitHub response body unavailable');
  const reader=response.body.getReader();
  try{
    const chunks=[];let length=0;
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      if(!(value instanceof Uint8Array))reject('ETAGJSON','GitHub response body invalid');
      length+=value.byteLength;
      if(length>MAX_BODY)reject('ETAGJSON','GitHub response too large');
      chunks.push(Buffer.from(value));
    }
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,length)));}
    catch{reject('ETAGJSON','GitHub response not valid JSON');}
  }finally{
    try{await reader.cancel();}catch{}
    try{reader.releaseLock();}catch{}
  }
}
async function request(method,path,token,{fetchImpl=fetch,body}={}){
  let response;
  try{
    response=await fetchImpl(ORIGIN+path,{
      method,redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',
        Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})
    });
  }catch{reject('ETAGNETWORK','GitHub tag endpoint request failed');}
  if(!response||!Number.isInteger(response.status))
    reject('ETAGNETWORK','GitHub response has no status');
  if(response.status===404||response.status===422||response.status===403){
    try{void response.body?.cancel();}catch{}
    return{status:response.status,json:null};
  }
  if(![200,201].includes(response.status)){
    try{void response.body?.cancel();}catch{}
    reject('ETAGHTTP',method+' tag operation returned HTTP '+response.status);
  }
  return{status:response.status,json:await getJson(response)};
}
async function resolveRef(ref,token,options){
  let obj=ref?.object;
  for(let depth=0;depth<5;depth++){
    if(!SHA.test(String(obj?.sha||'')))reject('ETAGREF','Tag ref has no valid object SHA');
    if(obj.type==='commit')return obj.sha;
    if(obj.type!=='tag'||depth===4)reject('ETAGREF','Unsupported tag reference chain');
    const r=await request('GET','/repos/'+REPOSITORY+'/git/tags/'+obj.sha,token,options);
    if(r.status!==200)reject('ETAGREF','Annotated tag object unavailable (HTTP '+r.status+')');
    obj=r.json?.object;
  }
  reject('ETAGREF','Tag reference chain too deep');
}
async function getTag(tag,token,options){
  const r=await request('GET','/repos/'+REPOSITORY+'/git/ref/tags/'+tag,token,options);
  if(r.status===404)return null;
  if(r.status!==200)reject('ETAGREAD','Tag ref lookup returned HTTP '+r.status);
  if(r.json?.ref!=='refs/tags/'+tag)reject('ETAGREF','Tag ref name mismatch');
  return resolveRef(r.json,token,options);
}
async function ensureTag({repository,tag,sha,token,fetchImpl=fetch}){
  identity({repository,tag,sha,token});
  const opts={fetchImpl};
  const existing=await getTag(tag,token,opts);
  if(existing!==null){
    if(existing!==sha)reject('ETAGMISMATCH','Immutable tag already points to another commit');
    return{ok:true,created:false,tag,sha};
  }
  const r=await request('POST','/repos/'+REPOSITORY+'/git/refs',token,{
    ...opts,body:{ref:'refs/tags/'+tag,sha}
  });
  if(r.status===422){
    // Concurrent creation: re-read, but accept only precisely matching SHA.
    const after=await getTag(tag,token,opts);
    if(after!==sha)reject('ETAGCONFLICT','Concurrent tag creation not bound to release SHA');
    return{ok:true,created:false,tag,sha};
  }
  if(r.status!==201)reject('ETAGCREATE','Tag creation refused (HTTP '+r.status+')');
  if(r.json?.ref!=='refs/tags/'+tag || r.json?.object?.type!=='commit' ||
     r.json.object.sha!==sha)
    reject('ETAGCREATE','GitHub creation acknowledgement does not match requested tag');
  // Verify the persisted ref, not only the POST acknowledgement.
  const verified=await getTag(tag,token,opts);
  if(verified!==sha)reject('ETAGCONFIRM','New immutable tag could not be read back at the exact SHA');
  return{ok:true,created:true,tag,sha};
}
if(require.main===module){
  ensureTag({repository:process.env.GITHUB_REPOSITORY,tag:process.env.RELEASE_TAG,
    sha:process.env.RELEASE_SHA,token:process.env.GH_TOKEN}).then(result=>{
      process.stdout.write(JSON.stringify(result)+'\n');
    }).catch(err=>{
      console.error(String(err.code||'ETAGERROR')+': '+String(err.message||'Tag verification failed'));
      process.exitCode=2;
    });
}
module.exports={identity,request,resolveRef,getTag,ensureTag};
