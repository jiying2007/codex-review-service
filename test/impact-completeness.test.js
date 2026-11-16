'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {collectImpact}=require('../src/quality');
const mr={project_id:7,source_project_id:7,diff_refs:{head_sha:'a'.repeat(40)}};
const profile={impactDepth:1,maxImpactFiles:16};
const diffResult={items:[{old_path:'src/motor.c',new_path:'src/motor.c',
  diff:'@@ -1 +1 @@\n-old\n+#include "motor.h"'}]};

test('impact candidate list beyond 64 marks incomplete, never silently clean',async()=>{
 const calls=[];
 const tree=Array.from({length:65},(_,i)=>({type:'blob',path:'include/p'+i+'/motor.h'}));
 const gitlab={
   listRepositoryTree:async()=>({complete:true,items:tree}),
   getRepositoryFileRaw:async(_id,p)=>{calls.push(p);return 'int motor(void);';}
 };
 const result=await collectImpact(gitlab,mr,diffResult,profile);
 assert.equal(result.complete,false);
 assert.equal(result.truncated,true);
 assert.ok(result.degradationReasons.includes('impact_candidate_limit'));
 assert.equal(calls.length,64);
});

test('impact tree cap and incomplete pagination remain observable',async()=>{
 const tree=Array.from({length:20001},(_,i)=>({type:'blob',path:'src/unrelated'+i+'.c'}));
 const result=await collectImpact({listRepositoryTree:async()=>({complete:false,items:tree}),
   getRepositoryFileRaw:async()=>null},mr,diffResult,profile);
 assert.equal(result.complete,false);
 assert.ok(result.degradationReasons.includes('impact_tree_limit'));
 assert.ok(result.degradationReasons.includes('impact_tree_pagination'));
});

test('failed exact-head dependency reads are not represented as a complete graph',async()=>{
 const gitlab={listRepositoryTree:async()=>({complete:true,items:[{type:'blob',path:'src/motor.c'}]}),
   getRepositoryFileRaw:async()=>null};
 const result=await collectImpact(gitlab,mr,diffResult,profile);
 assert.equal(result.complete,false);
 assert.ok(result.degradationReasons.includes('impact_candidate_missing'));
});
