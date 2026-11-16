'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const{buildReviewContext,lineWindow}=require('../src/context');

test('lineWindow bounds adjacent source context',()=>{const text=Array.from({length:20},(_,i)=>`line-${i+1}`).join('\n'),window=lineWindow(text,[10],2);assert.match(window,/8: line-8/);assert.match(window,/12: line-12/);assert.doesNotMatch(window,/7: line-7/);});

test('context is fetched from exact source head and target start SHAs',async()=>{const calls=[];const gitlab={getRepositoryFileRaw:async(project,path,ref)=>(calls.push({project,path,ref}),'a\nb\nc\nd\ne')};const mr={project_id:7,source_project_id:8,target_project_id:7,diff_refs:{head_sha:'head123',start_sha:'start456'}},chunk={files:[{path:'src/a.js',old_path:'src/a.js',new_path:'src/a.js',new_file:false,deleted_file:false,changedLines:{new:[3],old:[2]}}]},config={contextEnabled:true,maxContextBytes:10000,maxContextFiles:4,contextLines:1};const result=await buildReviewContext(gitlab,mr,chunk,config);assert.equal(result.complete,true);assert.deepEqual(calls,[{project:8,path:'src/a.js',ref:'head123'},{project:7,path:'src/a.js',ref:'start456'}]);assert.equal(result.blocks.length,2);});

test('context byte budget is fail-soft and never expands unbounded',async()=>{const gitlab={getRepositoryFileRaw:async()=>Array.from({length:100},()=>('x'.repeat(80))).join('\n')},mr={project_id:7,diff_refs:{head_sha:'h',start_sha:'s'}},chunk={files:[{path:'a.js',old_path:'a.js',new_path:'a.js',changedLines:{new:[50],old:[50]}}]},config={contextEnabled:true,maxContextBytes:100,maxContextFiles:2,contextLines:10};const result=await buildReviewContext(gitlab,mr,chunk,config);assert.equal(result.complete,false);assert.equal(result.reason,'context_budget');assert.equal(result.bytes,0);});


test('context cap accounts for every omitted side and does not silently skip later files',async()=>{
 const calls=[],gitlab={getRepositoryFileRaw:async(project,path,sha)=>{
   calls.push(path);return ['first','second','third','fourth'].join('\n');
 }};
 const mr={project_id:7,diff_refs:{head_sha:'h',start_sha:'s'}};
 const files=['src/a.c','src/b.c','src/c.c'].map(path=>({
   path,old_path:path,new_path:path,changedLines:{new:[2],old:[2]}
 }));
 const result=await buildReviewContext(gitlab,mr,{files},{
   contextEnabled:true,maxContextFiles:2,maxContextBytes:8000,contextLines:1
 });
 assert.equal(result.complete,false);
 assert.equal(result.requested,6);
 assert.equal(result.included,2);
 assert.equal(result.omitted.length,4);
 assert.ok(result.omitted.every(entry=>entry.reason==='context_file_limit'));
 assert.deepEqual(result.omittedFiles,['src/b.c','src/c.c']);
 assert.deepEqual(calls,['src/a.c','src/a.c']);
});

test('context fetch failures and byte limits remain visible without leaking source text',async()=>{
 const mr={project_id:7,diff_refs:{head_sha:'h',start_sha:'s'}};
 const paths=['src/a.c','src/b.c'].map(path=>({
   path,new_path:path,new_file:true,changedLines:{new:[10],old:[]}
 }));
 const gitlab={getRepositoryFileRaw:async(_project,path)=>{
   if(path==='src/a.c')throw Error('secret service URL must not escape');
   return Array.from({length:30},()=>('x'.repeat(100))).join('\n');
 }};
 const result=await buildReviewContext(gitlab,mr,{files:paths},{
   contextEnabled:true,maxContextFiles:2,maxContextBytes:100,contextLines:10
 });
 assert.equal(result.complete,false);
 assert.equal(result.requested,2);
 assert.deepEqual(result.omitted.map(item=>item.reason),['context_fetch_error','context_budget']);
 assert.equal(JSON.stringify(result).includes('secret service URL'),false);
});
