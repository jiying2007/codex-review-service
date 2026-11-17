'use strict';
// Offline-only validation: never creates volumes, opens SQLite, probes GitLab
// or invokes a model. It does not prove remote IAM, an OCI signature or readiness.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {buildShardedCatalog,validateShardedCatalog,readJson:readBoundedJson}=require('./sharded-catalog');
const DIGEST=/^[a-f0-9]{64}$/;
const PINNED_IMAGE=/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
const SECRET_ENV=[
  'LEGACY_GITLAB_API_TOKEN_FILE','LEGACY_GITLAB_WEBHOOK_TOKEN_FILE',
  'SENSOR_GITLAB_API_TOKEN_FILE','SENSOR_GITLAB_WEBHOOK_TOKEN_FILE'
];
function checkShardedConfig({env,legacy,sensor,catalog=null}){
 if(!env||!legacy||!sensor)throw Error('Two standalone configs and deployment environment are required');
 if(!DIGEST.test(String(env.CODEX_REVIEW_IMAGE_DIGEST||'')))
   throw Error('Use one verified complete Service OCI index SHA256 digest');
 if(env.CODEX_REVIEW_EDGE_IMAGE!==undefined && !PINNED_IMAGE.test(String(env.CODEX_REVIEW_EDGE_IMAGE)))
   throw Error('Optional legacy Nginx image must remain exact SHA256-pinned');
 for(const key of ['CODEX_REVIEW_LEGACY_STATE_VOLUME','CODEX_REVIEW_LEGACY_HOME_VOLUME',...SECRET_ENV])
   if(typeof env[key]!=='string'||!env[key].trim())
     throw Error('Missing required sharded deployment input: '+key);
 const edgePort=Number(env.CODEX_REVIEW_EDGE_PORT||8799);
 if(!Number.isSafeInteger(edgePort)||edgePort<1024||edgePort>65535||edgePort===8787)
   throw Error('Edge loopback port must not overlap legacy port 8787');
 const secrets=SECRET_ENV.map(name=>path.resolve(env[name]));
 if(new Set(secrets).size!==secrets.length)throw Error('Instances cannot reuse secret file paths');
 const instances=[['legacy',legacy],['sensor',sensor]];
 const origins=new Set(),keys=[];
 for(const [id,config] of instances){
   if(config.schemaVersion!==8||!config.gitlab||!config.webhook)
     throw Error(id+' requires current standalone Config Schema 8');
   if(config.server?.host!=='0.0.0.0'||config.server?.port!==8787)
     throw Error(id+' must listen on the container bridge interface and port 8787');
   if(config.server?.dataDir!=='/var/lib/codex-review/'+id||
       config.codex?.home!=='/home/codex-review/'+id)
     throw Error(id+' must use isolated container state and Codex home');
   const origin=String(config.gitlab.baseUrl||'').replace(/\/+$/,'');
   const expected=String(config.webhook.expectedInstance||'').replace(/\/+$/,'');
   if(!/^https?:\/\//.test(origin)||origin!==expected||origins.has(origin))
     throw Error('Independent GitLab origin and webhook instance identity required');
   origins.add(origin);
   if(!Array.isArray(config.gitlab.projects)||!Array.isArray(config.gitlab.groups)||
      !config.gitlab.projects.length&&!config.gitlab.groups.length)
     throw Error(id+' needs an explicit project or group allowlist');
   for(const p of config.gitlab.projects) {
     if(!Number.isSafeInteger(p)||p<1)throw Error('Unsafe configured project number');
     keys.push(id+':'+p);
   }
 }
 const configured=buildShardedCatalog({legacy,sensor});
 if(catalog){
   const supplied=validateShardedCatalog(catalog);
   if(supplied.sourceDigest!==configured.sourceDigest)
     throw Error('Non-secret catalog must exactly match current Legacy/Sensor project and group configuration');
 }
 return Object.freeze({schemaVersion:1,readyForReadOnlyPreflight:true,
   catalogVerified:Boolean(catalog),catalogDigest:configured.sourceDigest,
   serviceDigest:'sha256:'+env.CODEX_REVIEW_IMAGE_DIGEST,
   edgeMode:'native_service_image_without_secrets',
   legacyOptionalEdgeImage:env.CODEX_REVIEW_EDGE_IMAGE||null,
   edgeLoopbackPort:edgePort,configuredProjectKeys:keys.sort(),
   modelCalls:0,productionQualified:false,
   warning:'No remote API, image signature, Docker volume or database readiness evidence has been checked.'});
}
function verifyDistinctSecretFiles(env){
 // Use one descriptor for read + stat. Never output secret paths, values, or hashes.
 const digests=new Set();
 for(const key of SECRET_ENV){
   const filename=env?.[key];
   if(typeof filename!=='string'||!path.isAbsolute(filename))
     throw Error('Secret files must be absolute private paths');
   const flags=fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0);
   const fd=fs.openSync(filename,flags);
   try{
     const stat=fs.fstatSync(fd);
     if(!stat.isFile()||stat.nlink!==1||stat.size<1||stat.size>65536||
        process.platform!=='win32'&&(stat.mode&0o077)!==0)
       throw Error('Secret files must be private singly linked regular files');
     const buffer=Buffer.alloc(65537);
     let size=0;
     while(size<buffer.length){
       const count=fs.readSync(fd,buffer,size,buffer.length-size,null);
       if(count===0)break;
       size+=count;
     }
     if(size<1||size>65536||fs.fstatSync(fd).size>65536)
       throw Error('Secret file exceeds bounded length');
     const value=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size)).trim();
     if(!value||/[\r\n\0]/.test(value))
       throw Error('Secret file has invalid bounded content');
     const digest=crypto.createHash('sha256').update(value).digest('hex');
     if(digests.has(digest))throw Error('Different GitLab instances or secret roles reuse a credential');
     digests.add(digest);
   }finally{fs.closeSync(fd);}
 }
 return {secretFilesVerified:SECRET_ENV.length,credentialContentsDistinct:true};
}

function main(){
 const directory=path.resolve(process.argv[2]||'.');
 const read=name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
 const catalog=readBoundedJson(path.join(directory,'catalog.json'));
 const result=checkShardedConfig({env:process.env,legacy:read('legacy.json'),sensor:read('sensor.json'),catalog});
 const credentials=verifyDistinctSecretFiles(process.env);
 process.stdout.write(JSON.stringify({...result,...credentials},null,2)+'\n');
}
if(require.main===module){try{main();}catch(e){console.error('ESHARDEDPREFLIGHT: '+String(e?.code||'INVALID_DEPLOYMENT_CONFIGURATION'));process.exitCode=2;}}
module.exports={checkShardedConfig,verifyDistinctSecretFiles,main};
