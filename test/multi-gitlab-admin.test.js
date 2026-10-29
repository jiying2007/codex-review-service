'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {runAdmin}=require('../src/multi-gitlab-admin');

test('multi admin selects one SQLite/config identity and never passes a secret in argv',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'multi-admin-'));
  try{
    const defs=['legacy','sensor'].map((id,index)=>{
      const configFile=path.join(dir,id+'.json'),api=path.join(dir,id+'.api'),
        hook=path.join(dir,id+'.hook');
      fs.writeFileSync(api,'api-'+id);
      fs.writeFileSync(hook,'whsec_'+Buffer.alloc(32,index+20).toString('base64'));
      const origin=index?'http://192.168.2.50':'http://192.168.1.4';
      fs.writeFileSync(configFile,JSON.stringify({schemaVersion:8,
        server:{dataDir:path.join(dir,id+'-data')},
        gitlab:{baseUrl:origin,projects:[113],groups:[]},
        webhook:{expectedInstance:origin}}));
      return{id,configFile,homeDir:path.join(dir,id+'-home'),
        secretFiles:{GITLAB_API_TOKEN_FILE:api,GITLAB_WEBHOOK_SIGNING_TOKEN_FILE:hook}};
    });
    const manifest=path.join(dir,'multi.json');
    fs.writeFileSync(manifest,JSON.stringify({schemaVersion:1,
      server:{host:'127.0.0.1',port:8787,defaultInstance:'legacy',
        sharedProcessTrustAcknowledged:true},instances:defs}));
    const seen=[];
    const fake=(program,args,options)=>{seen.push({program,args,options});return{status:0};};
    assert.equal(runAdmin({manifestFile:manifest,id:'sensor',args:['db-check'],spawnImpl:fake}),0);
    assert.equal(runAdmin({manifestFile:manifest,id:'legacy',args:['status'],spawnImpl:fake}),0);
    assert.equal(seen.length,2);
    assert.equal(seen[0].options.env.CODEX_REVIEW_CONFIG_FILE,defs[1].configFile);
    assert.equal(seen[1].options.env.CODEX_REVIEW_CONFIG_FILE,defs[0].configFile);
    assert.notEqual(seen[0].options.env.HOME,seen[1].options.env.HOME);
    assert.equal(seen[0].options.shell,false);
    assert.equal(seen[0].options.env.GITLAB_API_TOKEN,undefined);
    assert.equal(seen[0].options.env.OPENAI_API_KEY,undefined);
    assert.ok(!JSON.stringify(seen.map(x=>x.args)).includes('api-sensor'));
    assert.throws(()=>runAdmin({manifestFile:manifest,id:'unknown',args:['status'],spawnImpl:fake}),/Unknown GitLab instance/);
    assert.throws(()=>runAdmin({manifestFile:manifest,id:'sensor',args:[],spawnImpl:fake}),/command is required/);
    assert.throws(()=>runAdmin({manifestFile:manifest,id:'sensor',args:['../bad'],spawnImpl:fake}),/Invalid admin command/);
    assert.equal(seen.length,2,'unknown GitLab must not spawn a host admin operation');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
