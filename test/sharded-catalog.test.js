'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildShardedCatalog,validateShardedCatalog,readJson}=require('../src/sharded-catalog');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const legacy={schemaVersion:8,gitlab:{baseUrl:'http://192.168.1.4',projects:[113,23],groups:[{id:48,includeSubgroups:true}]},webhook:{expectedInstance:'http://192.168.1.4'},
  codex:{apiKey:'DO_NOT_EXPOSE'},notifications:{token:'private'}};
const sensor={schemaVersion:8,gitlab:{baseUrl:'http://192.168.2.50',projects:[113],groups:[]},webhook:{expectedInstance:'http://192.168.2.50'}};
test('catalog defines unique instance-qualified projects without pretending group enumeration',()=>{
 const catalog=buildShardedCatalog({legacy,sensor});
 assert.equal(catalog.kind,'sharded_repository_catalog');
 assert.equal(catalog.freshApiQuery,false);assert.equal(catalog.modelCalls,0);
 assert.deepEqual(catalog.instances.map(x=>x.explicitProjects.map(y=>y.repositoryKey)),[
   ['legacy:23','legacy:113'],['sensor:113']
 ]);
 assert.equal(catalog.instances[0].groupEnumeration,'requires_live_authenticated_preflight');
 assert.equal(catalog.instances[0].groupSelectors[0].id,48);
 assert.deepEqual(validateShardedCatalog(catalog),catalog);
 assert.equal(catalog.sourceDigest,buildShardedCatalog({legacy,sensor}).sourceDigest);
});
test('catalog never copies provider secrets, tokens, Codex Home or arbitrary input fields',()=>{
 const s=JSON.stringify(buildShardedCatalog({legacy,sensor}));
 for(const value of ['DO_NOT_EXPOSE','private','apiKey','notifications','codex','/home/'])
   assert.equal(s.includes(value),false,value);
});
test('catalog rejects forged membership, extra fields, invalid IDs, same origins and drift',()=>{
 const good=buildShardedCatalog({legacy,sensor});
 assert.throws(()=>validateShardedCatalog({...good,extra:'injected'}),/noncanonical/);
 assert.throws(()=>validateShardedCatalog({...good,sourceDigest:'0'.repeat(64)}),/noncanonical/);
 const modified=JSON.parse(JSON.stringify(good));
 modified.instances[0].explicitProjects[0].repositoryKey='sensor:23';
 assert.throws(()=>validateShardedCatalog(modified),/identity/);
 assert.throws(()=>buildShardedCatalog({legacy,sensor:{...sensor,gitlab:{...sensor.gitlab,baseUrl:legacy.gitlab.baseUrl}}}),/origin/);
 assert.throws(()=>buildShardedCatalog({legacy:{...legacy,gitlab:{...legacy.gitlab,projects:[1,1]}},sensor}),/Duplicate/);
 assert.throws(()=>buildShardedCatalog({legacy:{...legacy,gitlab:{...legacy.gitlab,projects:[2**53]}},sensor}),/Unsafe/);
});


test('catalog reader rejects symlink, multi-linked, oversized and malformed files via same descriptor',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sharded-catalog-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const valid=path.join(dir,'valid.json'),alias=path.join(dir,'alias.json');
  fs.writeFileSync(valid,JSON.stringify({schemaVersion:1,kind:'fixture'}));
  assert.equal(readJson(valid).kind,'fixture');
  fs.linkSync(valid,alias);
  assert.throws(()=>readJson(valid),/singly-linked/);
  fs.unlinkSync(alias);
  if(process.platform!=='win32'){
    fs.symlinkSync(valid,alias);
    assert.throws(()=>readJson(alias),/ELOOP|symbolic link|symlink/i);
    fs.unlinkSync(alias);
  }
  fs.writeFileSync(valid,Buffer.alloc(1024*1024+1,65));
  assert.throws(()=>readJson(valid),/bounded/);
  fs.writeFileSync(valid,Buffer.from([0xff]));
  assert.throws(()=>readJson(valid),/encoded|UTF-8|UTF/i);
  fs.writeFileSync(valid,'{');
  assert.throws(()=>readJson(valid),SyntaxError);
});
