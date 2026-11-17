'use strict';
// Read-only, source-bound inventory. A Group selector does not prove that
// its member projects are reachable until a separate authenticated preflight.
const {loadMultiManifest,INSTANCE_ID}=require('./multi-gitlab-config');
function buildInventory(manifest){
 if(!manifest||!Array.isArray(manifest.instances)||manifest.instances.length>16)
   throw new TypeError('An already validated multi-instance manifest is required');
 const used=new Set(),instances=[];
 for(const instance of manifest.instances){
   if(!INSTANCE_ID.test(String(instance?.id||''))||used.has(instance.id))
     throw new TypeError('Duplicate or invalid GitLab instance ID');
   used.add(instance.id);
   const scope=instance.preflightScope;
   if(!scope||!Array.isArray(scope.projects)||!Array.isArray(scope.groups))
     throw new TypeError('Missing validated project/group scope');
   const projects=scope.projects.map(Number).sort((a,b)=>a-b);
   const groups=scope.groups.map(g=>({id:Number(g.id),includeSubgroups:g.includeSubgroups===true}))
     .sort((a,b)=>a.id-b.id);
   if([...projects,...groups.map(x=>x.id)].some(x=>!Number.isSafeInteger(x)||x<=0))
     throw new TypeError('Invalid numeric project/group identity');
   instances.push(Object.freeze({
     id:instance.id,gitlabOrigin:String(instance.origin),
     explicitProjects:projects.map(projectId=>Object.freeze({
       projectId,repositoryKey:instance.id+':'+projectId,status:'configured_not_live_verified'
     })),
     groupSelectors:groups,
     groupEnumeration:'requires_live_authenticated_preflight',
     workerIsolation:'per_gitlab_instance'
   }));
 }
 return Object.freeze({schemaVersion:1,kind:'multi_gitlab_config_inventory',
   freshApiQuery:false,modelCalls:0,
   instances:Object.freeze(instances),
   disclaimer:'Configured scopes only; not proof of remote repository membership, permissions, deployment or running Workers.'});
}
function main(){
 const manifest=loadMultiManifest(process.argv[2]||process.env.CODEX_REVIEW_MULTI_CONFIG_FILE);
 process.stdout.write(JSON.stringify(buildInventory(manifest),null,2)+'\n');
}
if(require.main===module){try{main();}catch(e){console.error(String(e.code||'EINVENTORY')+': '+String(e.message||e));process.exitCode=2;}}
module.exports={buildInventory,main};
