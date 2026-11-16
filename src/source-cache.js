'use strict';

// In-memory, per-Review-Job source reader. Never persists prompts, source,
// tokens, or credentials, and never aliases distinct project/ref/path tuples.
function createJobScopedGitLab(client,{maxEntries=48,maxTotalBytes=1024*1024,maxFileBytes=96*1024}={}){
 if(!client||typeof client.getRepositoryFileRaw!=='function')
   throw new TypeError('Job source cache requires a GitLab raw-file reader');
 const cache=new Map(),inflight=new Map();
 let bytes=0,hits=0,misses=0;
 const limits={entries:Math.max(0,Math.floor(Number(maxEntries)||0)),
   total:Math.max(0,Math.floor(Number(maxTotalBytes)||0)),
   file:Math.max(0,Math.floor(Number(maxFileBytes)||0))};
 async function read(projectId,path,ref){
   // SHA + project identity are immutable; a path alone is never a safe key.
   const key=JSON.stringify([Number(projectId),String(ref),String(path)]);
   if(cache.has(key)){
     const entry=cache.get(key);
     cache.delete(key);cache.set(key,entry);
     hits++;return entry.value;
   }
   if(inflight.has(key)){hits++;return inflight.get(key);}
   misses++;
   const pending=(async()=>{
     const value=await client.getRepositoryFileRaw(projectId,path,ref);
     if(typeof value!=='string'||!limits.entries||!limits.total||!limits.file)return value;
     const size=Buffer.byteLength(value,'utf8');
     if(size>limits.file||size>limits.total)return value;
     while(cache.size>=limits.entries||bytes+size>limits.total){
       const first=cache.keys().next().value;
       if(first===undefined)break;
       bytes-=cache.get(first).bytes;cache.delete(first);
     }
     cache.set(key,{value,bytes:size});bytes+=size;
     return value;
   })();
   inflight.set(key,pending);
   try{return await pending;}finally{inflight.delete(key);}
 }
 const gitlab=new Proxy(client,{get(target,property){
   if(property==='getRepositoryFileRaw')return read;
   const value=Reflect.get(target,property,target);
   return typeof value==='function'?value.bind(target):value;
 }});
 return Object.freeze({gitlab,stats:()=>Object.freeze({hits,misses,cachedEntries:cache.size,cachedBytes:bytes})});
}
module.exports={createJobScopedGitLab};
