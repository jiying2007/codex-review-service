#!/usr/bin/env node
'use strict';
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {loadMultiManifest,buildWorkerEnv}=require('./multi-gitlab-config');

function runAdmin({manifestFile,id,args,spawnImpl=spawnSync}){
  const manifest=loadMultiManifest(manifestFile);
  const tenant=manifest.instances.find(item=>item.id===id);
  if(!tenant){
    const error=new Error('Unknown GitLab instance; select an explicit configured ID');
    error.code='EUNKNOWNGITLAB';
    throw error;
  }
  if(!Array.isArray(args)||args.length===0){
    const error=new Error('Admin command is required for the selected GitLab instance');
    error.code='EADMINARGS';
    throw error;
  }
  const command=String(args[0]);
  if(!/^[a-z][a-z-]{0,63}$/.test(command)){
    const error=new Error('Invalid admin command');
    error.code='EADMINARGS';
    throw error;
  }
  const result=spawnImpl(process.execPath,
    [path.join(__dirname,'admin-cli.js'),...args],
    {env:buildWorkerEnv(tenant),stdio:'inherit',shell:false,timeout:120000});
  if(result.error)throw result.error;
  return Number.isInteger(result.status)?result.status:2;
}
if(require.main===module){
  try{
    const [id,...args]=process.argv.slice(2);
    process.exitCode=runAdmin({manifestFile:process.env.CODEX_REVIEW_MULTI_CONFIG_FILE,id,args});
  }catch(error){
    process.stderr.write(JSON.stringify({error:String(error.code||'EMULTIADMIN')})+'\n');
    process.exitCode=2;
  }
}
module.exports={runAdmin};
