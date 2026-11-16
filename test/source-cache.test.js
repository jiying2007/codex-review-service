'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createJobScopedGitLab}=require('../src/source-cache');

test('immutable project/ref/path identity scopes in-memory raw source reuse',async()=>{
 const calls=[],client={getRepositoryFileRaw:async(project,path,ref)=>{
   calls.push([project,path,ref]);return project+':'+path+':'+ref;
 }};
 const scope=createJobScopedGitLab(client);
 const gitlab=scope.gitlab;
 assert.equal(await gitlab.getRepositoryFileRaw(7,'src/a.c','sha-a'),'7:src/a.c:sha-a');
 assert.equal(await gitlab.getRepositoryFileRaw(7,'src/a.c','sha-a'),'7:src/a.c:sha-a');
 assert.equal(await gitlab.getRepositoryFileRaw(7,'src/a.c','sha-b'),'7:src/a.c:sha-b');
 assert.equal(await gitlab.getRepositoryFileRaw(8,'src/a.c','sha-a'),'8:src/a.c:sha-a');
 assert.equal(await gitlab.getRepositoryFileRaw(7,'src/b.c','sha-a'),'7:src/b.c:sha-a');
 assert.equal(calls.length,4);
 assert.equal(scope.stats().hits,1);
 assert.equal(scope.stats().cachedEntries,4);
 const another=createJobScopedGitLab(client);
 await another.gitlab.getRepositoryFileRaw(7,'src/a.c','sha-a');
 assert.equal(calls.length,5,'another review job has no cross-job cache');
});

test('concurrent reads deduplicate, failures do not persist and source content does not leak into stats',async()=>{
 let calls=0;
 const client={getRepositoryFileRaw:async()=>{
   calls++;if(calls===1)throw Error('sensitive upstream content');
   return 'confidential-source-text';
 }};
 const scope=createJobScopedGitLab(client);
 await assert.rejects(scope.gitlab.getRepositoryFileRaw(7,'x','a'));
 const responses=await Promise.all([scope.gitlab.getRepositoryFileRaw(7,'x','a'),
   scope.gitlab.getRepositoryFileRaw(7,'x','a')]);
 assert.deepEqual(responses,['confidential-source-text','confidential-source-text']);
 assert.equal(calls,2);
 assert.equal(scope.stats().hits,1);
 assert.ok(!JSON.stringify(scope.stats()).includes('confidential'));
});

test('cache enforces exact UTF-8 bounds and evicts least recently used content',async()=>{
 const counts=new Map(),client={getRepositoryFileRaw:async(_p,path)=>{
   counts.set(path,(counts.get(path)||0)+1);return path.repeat(2);
 }};
 const scope=createJobScopedGitLab(client,{maxEntries:2,maxTotalBytes:12,maxFileBytes:9});
 for(const path of ['aa','bbb','aa','cc','bbb'])
   await scope.gitlab.getRepositoryFileRaw(7,path,'sha');
 assert.equal(counts.get('aa'),1);
 assert.equal(counts.get('bbb'),2);
 assert.ok(scope.stats().cachedEntries<=2);
 assert.ok(scope.stats().cachedBytes<=12);
 const big=await scope.gitlab.getRepositoryFileRaw(7,'xxxxxxxxxx','sha');
 assert.equal(big.length,20);
 await scope.gitlab.getRepositoryFileRaw(7,'xxxxxxxxxx','sha');
 assert.equal(counts.get('xxxxxxxxxx'),2,'oversized payload is never cached');
});


test('offline service fixtures without raw-file capability stay compatible',()=>{
 const client={listMergeRequestDiffs:async()=>({complete:true,items:[]})};
 const scope=createJobScopedGitLab(client);
 assert.equal(scope.gitlab,client);
 assert.deepEqual(scope.stats(),{hits:0,misses:0,cachedEntries:0,cachedBytes:0});
});
