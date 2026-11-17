'use strict';
// Non-secret configured-scope snapshot. No GitLab or model requests are made.
// An explicitly configured project is not evidence of remote membership.
const fs=require('node:fs');
const crypto=require('node:crypto');
const INSTANCE_ID=/^[a-z][a-z0-9-]{0,31}$/;
const MAX_INSTANCES=16;
function orderedIds(configs){
 if(!configs||typeof configs!=='object'||Array.isArray(configs))throw new TypeError('Standalone instance configs are required');
 const ids=Object.keys(configs);
 if(ids.length<1||ids.length>MAX_INSTANCES||ids.some(id=>!INSTANCE_ID.test(id)))
   throw new TypeError('Catalog requires 1-16 explicitly named GitLab instances');
 return ids.sort((a,b)=>a.localeCompare(b));
}
const MAX_PROJECTS=256,MAX_GROUPS=64,MAX_FILE_BYTES=1024*1024;
function requireId(value,label) {
  if(!Number.isSafeInteger(value)||value<1)throw new TypeError('Unsafe '+label+' GitLab ID');
  return value;
}
function canonicalOrigin(value) {
  if(typeof value!=='string')throw new TypeError('GitLab origin is required');
  let url;
  try{url=new URL(value);}catch{throw new TypeError('Invalid GitLab origin');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)
    throw new TypeError('GitLab origin must be credential-free http(s)');
  const pathname=url.pathname.replace(/\/+$/,'');
  if(pathname.split('/').some(part=>part==='..'||part==='.') || /[\u0000-\u001f]/.test(pathname))
    throw new TypeError('Unsafe GitLab origin path');
  return url.origin.toLowerCase()+pathname;
}
function buildShardedCatalog(configs) {
  const ids=orderedIds(configs);
  const origins=new Set();
  const instances=ids.map(id=>{
    const cfg=configs[id];
    if(cfg?.schemaVersion!==8||!cfg.gitlab||!cfg.webhook)throw new TypeError(id+' requires Config Schema 8');
    const origin=canonicalOrigin(cfg.gitlab.baseUrl);
    if(canonicalOrigin(cfg.webhook.expectedInstance)!==origin)throw new TypeError(id+' webhook origin mismatch');
    if(origins.has(origin))throw new TypeError('Different instances must have different GitLab origins');
    origins.add(origin);
    const rawProjects=cfg.gitlab.projects,rawGroups=cfg.gitlab.groups;
    if(!Array.isArray(rawProjects)||rawProjects.length>MAX_PROJECTS||
       !Array.isArray(rawGroups)||rawGroups.length>MAX_GROUPS ||
       rawProjects.length+rawGroups.length===0)throw new TypeError(id+' project/group scope is invalid or over limit');
    const projectIds=rawProjects.map(p=>requireId(p,'project')).sort((a,b)=>a-b);
    const groupIds=rawGroups.map(g=>{
      if(!g||typeof g!=='object'||(g.includeSubgroups!==undefined&&typeof g.includeSubgroups!=='boolean'))
        throw new TypeError('Invalid GitLab group selector');
      return {id:requireId(g.id,'group'),includeSubgroups:g.includeSubgroups===true};
    }).sort((a,b)=>a.id-b.id);
    if(new Set(projectIds).size!==projectIds.length ||
       new Set(groupIds.map(g=>g.id)).size!==groupIds.length)throw new TypeError('Duplicate scope ID');
    return {id,gitlabOrigin:origin,
      explicitProjects:projectIds.map(projectId=>({
        projectId,repositoryKey:id+':'+projectId,status:'configured_not_live_verified'
      })),
      groupSelectors:groupIds,
      groupEnumeration:'requires_live_authenticated_preflight'};
  });
  const sourceDigest=crypto.createHash('sha256').update(JSON.stringify(instances)).digest('hex');
  return Object.freeze({schemaVersion:2,kind:'sharded_repository_catalog',
    sourceDigest,modelCalls:0,freshApiQuery:false,instances,
    warning:'Configured scopes only. No live GitLab project membership, authorization or deployment is verified.'});
}
function validateShardedCatalog(catalog) {
  if(!catalog||catalog.schemaVersion!==2||catalog.kind!=='sharded_repository_catalog'||
     !Array.isArray(catalog.instances)||catalog.instances.length<1||catalog.instances.length>MAX_INSTANCES)
    throw new TypeError('Sharded repository catalog has an invalid schema');
  const configs=Object.create(null);
  const ids=catalog.instances.map(item=>item?.id);
  if(ids.some(id=>typeof id!=='string'||!INSTANCE_ID.test(id))||
     ids.length!==new Set(ids).size)
    throw new TypeError('Sharded catalog has invalid or duplicate instance identities');
  for(let i=0;i<ids.length;i++){
    const id=ids[i],entry=catalog.instances[i];
    if(!Array.isArray(entry.explicitProjects)||!Array.isArray(entry.groupSelectors))
      throw new TypeError('Sharded catalog has ambiguous instance identities');
    configs[id]={schemaVersion:8,gitlab:{
      baseUrl:entry.gitlabOrigin,projects:entry.explicitProjects.map(p=>{
        if(p?.repositoryKey!==id+':'+p.projectId||p.status!=='configured_not_live_verified')
          throw new TypeError('Untrusted repository catalog identity');
        return p.projectId;
      }),groups:entry.groupSelectors
    },webhook:{expectedInstance:entry.gitlabOrigin}};
  }
  const trusted=buildShardedCatalog(configs);
  if(JSON.stringify(catalog)!==JSON.stringify(trusted))
    throw new TypeError('Sharded catalog contains untrusted, stale or noncanonical fields');
  return trusted;
}
function readJson(file){
  // Pin every check and byte to the SAME opened descriptor to prevent a
  // check/use swap. O_NONBLOCK also prevents an injected FIFO from hanging.
  const flags=fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW||0) |
    (fs.constants.O_NONBLOCK||0);
  const fd=fs.openSync(file,flags);
  try{
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.size<1||stat.size>MAX_FILE_BYTES)
      throw new TypeError('Catalog/config must be a bounded singly-linked regular file');
    const buf=Buffer.allocUnsafe(MAX_FILE_BYTES+1);
    let size=0;
    while(size<buf.length){
      const count=fs.readSync(fd,buf,size,buf.length-size,null);
      if(count===0)break;
      size+=count;
    }
    if(size<1||size>MAX_FILE_BYTES)
      throw new TypeError('Catalog/config content exceeded its bounded read');
    const decoded=new TextDecoder('utf-8',{fatal:true}).decode(buf.subarray(0,size));
    return JSON.parse(decoded);
  }finally{
    fs.closeSync(fd);
  }
}
function main(args=process.argv.slice(2)){
  // Breaking v8 contract: every config must carry its own explicit instance ID.
  // Never auto-classify unnamed files as a default/legacy GitLab instance.
  if(args.length<1||args.length>MAX_INSTANCES)
    throw new TypeError('Usage: sharded-catalog.js id=/absolute/config.json [id=/absolute/config.json ...]');
  const configs=Object.create(null);
  for(const item of args){
    const pos=item.indexOf('='),id=item.slice(0,pos),file=item.slice(pos+1);
    if(pos<1||!INSTANCE_ID.test(id)||!require('node:path').isAbsolute(file)||Object.hasOwn(configs,id))
      throw new TypeError('Every instance requires a unique id=/absolute/config.json mapping');
    configs[id]=readJson(file);
  }
  const catalog=buildShardedCatalog(configs);
  process.stdout.write(JSON.stringify(catalog,null,2)+'\n');
}
if(require.main===module){try{main();}catch(e){console.error('ECATALOG: '+String(e.message||e));process.exitCode=2;}}
module.exports={buildShardedCatalog,validateShardedCatalog,readJson,main,orderedIds,INSTANCE_ID,MAX_INSTANCES};
