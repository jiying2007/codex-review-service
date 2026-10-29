'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {runPreflight}=require('../src/multi-gitlab-preflight');

function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'multi-preflight-'));
  function make(id,url,token,index){
    const config=path.join(dir,id+'.json'),api=path.join(dir,id+'.token'),
      signing=path.join(dir,id+'.signing');
    fs.writeFileSync(config,JSON.stringify({schemaVersion:8,
      server:{dataDir:path.join(dir,id+'-data')},gitlab:{
        baseUrl:url,projects:[113],groups:id==='legacy'?[{id:48,includeSubgroups:true}]:[]
      },webhook:{expectedInstance:url}}));
    fs.writeFileSync(api,token);
    fs.writeFileSync(signing,'whsec_'+Buffer.alloc(32,index).toString('base64'));
    return{id,configFile:config,homeDir:path.join(dir,id+'-home'),
      secretFiles:{GITLAB_API_TOKEN_FILE:api,GITLAB_WEBHOOK_SIGNING_TOKEN_FILE:signing}};
  }
  const legacy=make('legacy','http://192.168.1.4','old-only-read-token',7);
  const sensor=make('sensor','http://192.168.2.50','new-only-read-token',8);
  const file=path.join(dir,'multi.json');
  fs.writeFileSync(file,JSON.stringify({schemaVersion:1,
    server:{host:'127.0.0.1',port:8787,defaultInstance:'legacy',sharedProcessTrustAcknowledged:true},instances:[legacy,sensor]}));
  return {file,close:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('read-only multi preflight probes each project/group with the correct server credential',async()=>{
  const f=fixture(),calls=[];
  try{
    const mock=async(url,options)=>{
      calls.push({url:String(url),options});
      return {ok:true,status:200,json:async()=>({version:'17.11.7'})};
    };
    const r=await runPreflight({manifestFile:f.file,fetchImpl:mock});
    assert.equal(r.ok,true);
    assert.equal(r.noModelInvocations,true);
    assert.equal(r.mode,'read-only');
    assert.deepEqual(r.results.map(x=>[x.id,x.checkedProjects,x.checkedGroups]),
      [['legacy',1,1],['sensor',1,0]]);
    assert.equal(calls.length,5);
    assert.equal(calls.filter(c=>c.url.includes('/projects/113')).length,2);
    assert.equal(calls.filter(c=>c.url.includes('/groups/48')).length,1);
    for(const call of calls){
      assert.equal(call.options.method,'GET');
      assert.equal(call.options.redirect,'error');
      assert.equal(call.options.headers['PRIVATE-TOKEN'],
        call.url.includes('192.168.1.4')?'old-only-read-token':'new-only-read-token');
    }
    assert.doesNotMatch(JSON.stringify(r),/old-only-read-token|new-only-read-token/);
  }finally{f.close();}
});
test('one GitLab API permission failure does not conceal the other server state',async()=>{
  const f=fixture();
  try{
    const mock=async(url)=>url.includes('192.168.2.50') && url.includes('/projects/113')?
      {ok:false,status:403}:{ok:true,status:200,json:async()=>({version:'17.11.7'})};
    const r=await runPreflight({manifestFile:f.file,fetchImpl:mock});
    assert.equal(r.ok,false);
    assert.equal(r.results[0].apiReadable,true);
    assert.equal(r.results[1].apiReadable,false);
    assert.equal(r.results[1].code,'EGITLABREAD');
  }finally{f.close();}
});
test('unsupported old GitLab API fails closed before any webhook or model calls',async()=>{
  const f=fixture();
  try{
    const mock=async()=>({ok:true,status:200,json:async()=>({version:'14.6.0'})});
    const r=await runPreflight({manifestFile:f.file,fetchImpl:mock});
    assert.equal(r.ok,false);
    assert.deepEqual(r.results.map(item=>item.code),['EGITLABVERSION','EGITLABVERSION']);
  }finally{f.close();}
});
