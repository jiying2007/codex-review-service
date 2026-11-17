'use strict';
// Offline-only validation: never creates volumes, opens SQLite, probes GitLab
// or invokes a model. It does not prove remote IAM, an OCI signature or readiness.
const fs=require('node:fs');
const path=require('node:path');
const DIGEST=/^[a-f0-9]{64}$/;
const PINNED_IMAGE=/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}$/;
const SECRET_ENV=[
  'LEGACY_GITLAB_API_TOKEN_FILE','LEGACY_GITLAB_WEBHOOK_TOKEN_FILE',
  'SENSOR_GITLAB_API_TOKEN_FILE','SENSOR_GITLAB_WEBHOOK_TOKEN_FILE'
];
function checkShardedConfig({env,legacy,sensor}){
 if(!env||!legacy||!sensor)throw Error('Two standalone configs and deployment environment are required');
 if(!DIGEST.test(String(env.CODEX_REVIEW_IMAGE_DIGEST||'')))
   throw Error('Use one verified complete Service OCI index SHA256 digest');
 if(!PINNED_IMAGE.test(String(env.CODEX_REVIEW_EDGE_IMAGE||'')))
   throw Error('Edge proxy image must be an exact SHA256-pinned container reference');
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
 return Object.freeze({schemaVersion:1,readyForReadOnlyPreflight:true,
   serviceDigest:'sha256:'+env.CODEX_REVIEW_IMAGE_DIGEST,
   edgeImage:env.CODEX_REVIEW_EDGE_IMAGE,
   edgeLoopbackPort:edgePort,configuredProjectKeys:keys.sort(),
   modelCalls:0,productionQualified:false,
   warning:'No remote API, image signature, Docker volume or database readiness evidence has been checked.'});
}
function main(){
 const directory=path.resolve(process.argv[2]||'.');
 const read=name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
 const result=checkShardedConfig({env:process.env,legacy:read('legacy.json'),sensor:read('sensor.json')});
 for(const name of SECRET_ENV){
   const stat=fs.lstatSync(process.env[name]);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||process.platform!=='win32'&&(stat.mode&0o077)!==0)
     throw Error('Secret paths must name private, singly linked regular files: '+name);
 }
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if(require.main===module){try{main();}catch(e){console.error('ESHARDEDPREFLIGHT: '+String(e.message||e));process.exitCode=2;}}
module.exports={checkShardedConfig,main};
