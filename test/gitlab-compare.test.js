'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const{GitLabClient}=require('../src/gitlab');

test('compareCommits requests straight source-head delta and exposes timeout completeness',async()=>{const client=new GitLabClient({gitlabApiUrl:'https://gitlab.test/api/v4',gitlabToken:'token',statusName:'codex-review',gitlabRequestsPerSecond:20,gitlabCircuitFailureThreshold:8,gitlabCircuitResetMs:30000,gitlabRequestTimeoutMs:30000,gitlabMaxPages:10,gitlabStatusRetries:1});let captured;client.request=async(method,pathname,options)=>{captured={method,pathname,options};return{data:{diffs:[{old_path:'a.js',new_path:'a.js',diff:'@@ -1 +1 @@\n-a\n+b'}],commits:[{id:'b'}],compare_timeout:false}};};const result=await client.compareCommits(7,'a','b');assert.equal(captured.method,'GET');assert.equal(captured.pathname,'/projects/7/repository/compare');assert.deepEqual(captured.options.query,{from:'a',to:'b',straight:true});assert.equal(result.complete,true);assert.equal(result.items.length,1);assert.equal(result.commitCount,1);});
