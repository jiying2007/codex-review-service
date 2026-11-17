'use strict';
// Strict, read-only v8 fleet preflight. Never opens SQLite or invokes GitLab/model APIs.
// Edge-side checks require NO tenant secrets; optional credential audit runs on
// an operator-controlled node where independently provisioned files are available.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {buildShardedCatalog,validateShardedCatalog,readJson,INSTANCE_ID,MAX_INSTANCES}=require('./sharded-catalog');
const {targetMap}=require('./sharded-edge');
const DIGEST=/^[a-f0-9]{64}$/;
function checkShardedConfig({env,catalog,targets,configs=null}={}){
 if(!env||!DIGEST.test(String(env.CODEX_REVIEW_IMAGE_DIGEST||'')))
   throw new TypeError('Exact verified Service OCI index digest is required');
 const trusted=validateShardedCatalog(catalog);
 const ids=trusted.instances.map(item=>item.id);
 targetMap(targets,ids);
 let scopeMatches=null;
 if(configs!==null){
   const expected=buildShardedCatalog(configs);
   if(expected.sourceDigest!==trusted.sourceDigest)
     throw new TypeError('Fleet catalog differs from explicitly supplied standalone Config Schema 8 files');
   scopeMatches=true;
 }
 const port=Number(env.CODEX_REVIEW_EDGE_PORT||8799);
 if(!Number.isSafeInteger(port)||port<1024||port>65535||port===8787)
   throw new TypeError('Private loopback Edge port must be between 1024 and 65535, excluding 8787');
 return Object.freeze({schemaVersion:2,mode:'read_only_offline_preflight',
   instanceCount:ids.length,instances:ids,sourceDigest:trusted.sourceDigest,
   configuredProjectKeys:trusted.instances.flatMap(item=>item.explicitProjects.map(p=>p.repositoryKey)),
   configuredGroupSelectors:trusted.instances.reduce((n,item)=>n+item.groupSelectors.length,0),
   configScopeVerified:scopeMatches,edgeTargetMapVerified:true,
   imageDigest:'sha256:'+env.CODEX_REVIEW_IMAGE_DIGEST,
   edgeLoopbackPort:port,modelCalls:0,productionQualified:false,
   warning:'Image signature, per-host database state, remote project authorization and webhook delivery are not verified.'});
}
function verifyDistinctSecretFiles(files){
 if(!Array.isArray(files)||files.length<2||files.length>MAX_INSTANCES*2)
   throw new TypeError('Supply 2-32 explicitly selected private credential files');
 const seenFiles=new Set(),seenDigests=new Set();
 for(const file of files){
   if(typeof file!=='string'||!path.isAbsolute(file)||seenFiles.has(path.resolve(file)))
     throw new TypeError('Credential file path must be an absolute unique path');
   seenFiles.add(path.resolve(file));
   const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0));
   try{
     const stat=fs.fstatSync(fd);
     if(!stat.isFile()||stat.nlink!==1||stat.size<1||stat.size>65536||
       process.platform!=='win32'&&(stat.mode&0o077)!==0)
       throw new TypeError('Credentials must be private, singly linked regular files');
     const buf=Buffer.alloc(65537);let size=0;
     while(size<buf.length){
       const n=fs.readSync(fd,buf,size,buf.length-size,null);
       if(n===0)break;
       size+=n;
     }
     if(size<1||size>65536||fs.fstatSync(fd).size>65536)
       throw new TypeError('Credential size exceeds bound');
     const value=new TextDecoder('utf-8',{fatal:true}).decode(buf.subarray(0,size)).trim();
     if(!value||/[\r\n\0]/.test(value))throw new TypeError('Invalid credential file');
     const hash=crypto.createHash('sha256').update(value).digest('hex');
     if(seenDigests.has(hash))throw new TypeError('Credential reuse across trust domains or roles is forbidden');
     seenDigests.add(hash);
   }finally{fs.closeSync(fd);}
 }
 return Object.freeze({filesVerified:files.length,credentialContentsDistinct:true,secretsExposed:false});
}
function main(args=process.argv.slice(2)){
 if(args.length<2||args.length>MAX_INSTANCES+2)
   throw new TypeError('Usage: sharded-deploy-check.js /absolute/catalog.json /absolute/targets.json [id=/absolute/config.json ...]');
 const [catalogPath,targetsPath,...sources]=args;
 if(!path.isAbsolute(catalogPath)||!path.isAbsolute(targetsPath))
   throw new TypeError('Catalog and target-map paths must be absolute');
 let configs=null;
 if(sources.length){
   configs=Object.create(null);
   for(const spec of sources){
     const pos=spec.indexOf('='),id=spec.slice(0,pos),filename=spec.slice(pos+1);
     if(pos<1||!INSTANCE_ID.test(id)||!path.isAbsolute(filename)||Object.hasOwn(configs,id))
       throw new TypeError('Invalid source mapping; use unique id=/absolute/config.json');
     configs[id]=readJson(filename);
   }
 }
 const result=checkShardedConfig({env:process.env,catalog:readJson(catalogPath),
   targets:readJson(targetsPath),configs});
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
 return result;
}
if(require.main===module){try{main();}catch(error){
 console.error('ESHARDEDPREFLIGHT: '+String(error?.code||'INVALID_DEPLOYMENT_CONFIGURATION'));
 process.exitCode=2;
}}
module.exports={checkShardedConfig,verifyDistinctSecretFiles,main};
