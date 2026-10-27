'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {GitLabClient}=require('../src/gitlab');
const marker='<!-- codex-review-service:summary -->';
function harness(notes,{actor={id:22,username:'service-bot'},complete=true}={}){
 const client=new GitLabClient({gitlabApiUrl:'https://gitlab.test/api/v4',gitlabToken:'fixture-token',statusName:'codex-safe'});
 const calls=[];
 client.request=async(method,route)=>{calls.push([method,route]);assert.equal(route,'/user');return{data:actor};};
 client.listNotes=async()=>({complete,items:notes});
 client.updateNote=async(_p,_i,noteId,body)=>{calls.push(['PUT',noteId,body]);return{id:noteId};};
 client.createNote=async(_p,_i,body)=>{calls.push(['POST',body]);return{id:77};};
 return{client,calls};
}
test('external user summary marker cannot redirect a bot update',async()=>{
 const {client,calls}=harness([{id:11,author:{id:44},body:marker}]);
 await client.upsertSummary(1,2,'Summary');
 assert.deepEqual(calls.map(x=>x[0]),['GET','POST']);
 assert.match(calls[1][1],/Summary/);
});
test('authenticated actor selects own summary note even when a foreign marker precedes it',async()=>{
 const {client,calls}=harness([{id:11,author:{id:44},body:marker},{id:12,author:{id:22},body:marker}]);
 await client.upsertSummary(1,2,'New summary');
 assert.deepEqual(calls.map(x=>x[0]),['GET','PUT']);
 assert.equal(calls[1][1],12);
 assert.match(calls[1][2],/New summary/);
});
test('duplicate actor-owned markers remain unresolved rather than arbitrarily overwritten',async()=>{
 const {client,calls}=harness([{id:11,author:{id:22},body:marker},{id:12,author:{id:22},body:marker}]);
 await assert.rejects(()=>client.upsertSummary(1,2,'Summary'),error=>error.code==='EGITLABAMBIGUOUS');
 assert.deepEqual(calls.map(x=>x[0]),['GET']);
});
test('missing actor identity and incomplete note pagination block summary publication',async()=>{
 const missing=harness([{id:11,author:{id:22},body:marker}],{actor:{id:null}});
 await assert.rejects(()=>missing.client.upsertSummary(1,2,'Summary'),error=>error.code==='EGITLABAUTHOR');
 assert.deepEqual(missing.calls.map(x=>x[0]),['GET']);
 const pages=harness([],{complete:false});
 await assert.rejects(()=>pages.client.upsertSummary(1,2,'Summary'),error=>error.code==='EGITLABPAGINATION');
 assert.deepEqual(pages.calls.map(x=>x[0]),['GET']);
});
