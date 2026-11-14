'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {createStorage}=require('../src/storage');

test('second controller cannot mutate running jobs; ownership transfers after close',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'service-owner-')),file=path.join(dir,'state.sqlite');
  let first,second;
  try{
    first=createStorage({dbPath:file,controllerOwner:true});
    const job=first.enqueue({projectId:1,mrIid:1,trigger:'open',dedupeKey:'one'});first.claimNext();
    assert.throws(()=>createStorage({dbPath:file,controllerOwner:true}),{code:'ECONTROLLEROWNERSHIP'});
    assert.equal(first.getJob(job).status,'running');
    first.close();first=null;
    second=createStorage({dbPath:file,controllerOwner:true});
    assert.equal(second.recoverInterruptedJobs(),1);assert.equal(second.getJob(job).status,'queued');
  }finally{first?.close();second?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('OS releases controller ownership after process termination',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'service-owner-death-')),file=path.join(dir,'state.sqlite');
  const child=spawn(process.execPath,['-e',`
    const {createStorage}=require(${JSON.stringify(require.resolve('../src/storage'))});
    const store=createStorage({dbPath:process.argv[1],controllerOwner:true});
    store.enqueue({projectId:1,mrIid:1,trigger:'open',dedupeKey:'one'});store.claimNext();
    process.stdout.write('ready\\n');setInterval(()=>{},1000);
  `,file],{stdio:['ignore','pipe','pipe']});
  let successor;
  try{
    await once(child.stdout,'data');
    assert.throws(()=>createStorage({dbPath:file,controllerOwner:true}),{code:'ECONTROLLEROWNERSHIP'});
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    successor=createStorage({dbPath:file,controllerOwner:true});assert.equal(successor.recoverInterruptedJobs(),1);
  }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}successor?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('independent state databases keep independent controller ownership',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'service-owner-instances-'));
  const stores=[];
  try{for(const name of ['first','second'])stores.push(createStorage({dbPath:path.join(dir,`${name}.sqlite`),controllerOwner:true}));assert.equal(stores.length,2);}
  finally{for(const store of stores)store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
