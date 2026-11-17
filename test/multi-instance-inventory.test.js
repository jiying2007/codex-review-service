'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildInventory}=require('../src/multi-instance-inventory');

const manifest={instances:[
 {id:'legacy',origin:'http://192.168.1.4',homeDir:'/home/credential-private',
  secretFiles:{GITLAB_API_TOKEN_FILE:'/not/public'},preflightScope:{
    projects:[113,3],groups:[{id:48,includeSubgroups:true}]}},
 {id:'sensor',origin:'http://192.168.2.50',homeDir:'/home/other',
  preflightScope:{projects:[113],groups:[]}}
]};
test('inventory distinguishes same numeric project IDs on distinct GitLabs',()=>{
 const a=buildInventory(manifest);
 assert.equal(a.freshApiQuery,false);assert.equal(a.modelCalls,0);
 assert.deepEqual(a.instances.map(x=>x.explicitProjects.map(p=>p.repositoryKey)),[
   ['legacy:3','legacy:113'],['sensor:113']
 ]);
 assert.equal(a.instances[0].groupSelectors[0].id,48);
 assert.equal(a.instances[0].groupEnumeration,'requires_live_authenticated_preflight');
 assert.equal(a.instances[1].groupSelectors.length,0);
});
test('inventory discloses no credential paths, tokens or Codex home',()=>{
 const plain=JSON.stringify(buildInventory(manifest));
 for(const forbidden of ['/home/credential-private','/not/public','secretFiles','homeDir','GITLAB_API_TOKEN_FILE'])
   assert.equal(plain.includes(forbidden),false);
 assert.match(plain,/configured_not_live_verified/);
});
test('inventory rejects ambiguous identities and invalid project IDs',()=>{
 assert.throws(()=>buildInventory({instances:[manifest.instances[0],manifest.instances[0]]}),/Duplicate/);
 assert.throws(()=>buildInventory({instances:[{...manifest.instances[0],preflightScope:{projects:[Number.MAX_SAFE_INTEGER+1],groups:[]}}]}),/Invalid numeric/);
 assert.throws(()=>buildInventory({instances:[{...manifest.instances[0],id:'A'}]}),/invalid/);
});
