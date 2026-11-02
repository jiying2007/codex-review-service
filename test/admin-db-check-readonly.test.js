'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const admin=require('../src/admin');
const cli=require('../src/admin-cli');
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'service-admin-check-'));
  return {dir,file:path.join(dir,'review-service.sqlite'),close:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
function digest(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
async function checked(file,command=['db-check']){
  const oldPath=admin.requireDbPath,oldOpen=admin.openStore,oldWrite=process.stdout.write,oldExit=process.exitCode;
  let opened=0,output='';
  admin.requireDbPath=()=>file;
  admin.openStore=()=>{opened++;throw Error('db-check must never open a mutating Store');};
  process.stdout.write=(value)=>{output+=String(value);return true;};
  process.exitCode=undefined;
  try{
    await cli.main(command);
    return {opened,output:JSON.parse(output),exit:process.exitCode};
  }finally{
    admin.requireDbPath=oldPath;admin.openStore=oldOpen;
    process.stdout.write=oldWrite;process.exitCode=oldExit;
  }
}
test('old Schema 10 db-check fails non-mutating and preserves bytes',async()=>{
  const f=fixture();
  try{
    const db=new DatabaseSync(f.file);
    db.exec("CREATE TABLE legacy(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO legacy(value) VALUES('historical'); PRAGMA user_version=10;");
    db.close();
    const hash=digest(f.file);
    const result=await checked(f.file);
    assert.equal(result.opened,0);
    assert.equal(result.output.schemaVersion,10);
    assert.equal(result.output.compatible,false);
    assert.equal(result.exit,2);
    assert.equal(digest(f.file),hash);
    const verify=new DatabaseSync(f.file,{readOnly:true});
    try{
      assert.equal(verify.prepare('PRAGMA user_version').get().user_version,10);
      assert.equal(verify.prepare('SELECT value FROM legacy').get().value,'historical');
    }finally{verify.close();}
  }finally{f.close();}
});
test('current Schema 11 db-check is read-only and successful',async()=>{
  const f=fixture();
  try{
    const db=new DatabaseSync(f.file);
    db.exec('CREATE TABLE marker(id INTEGER PRIMARY KEY); PRAGMA user_version=11;');
    db.close();
    const before=digest(f.file);
    const result=await checked(f.file);
    assert.equal(result.opened,0);
    assert.equal(result.output.compatible,true);
    assert.equal(result.exit,undefined);
    assert.equal(digest(f.file),before);
  }finally{f.close();}
});
test('missing database cannot be created by db-check',async()=>{
  const f=fixture();
  try{
    assert.equal(fs.existsSync(f.file),false);
    const oldPath=admin.requireDbPath,oldOpen=admin.openStore;
    let count=0;
    admin.requireDbPath=()=>f.file;
    admin.openStore=()=>{count++;throw Error('must not run');};
    try{await assert.rejects(cli.main(['db-check']));}
    finally{admin.requireDbPath=oldPath;admin.openStore=oldOpen;}
    assert.equal(count,0);
    assert.equal(fs.existsSync(f.file),false);
  }finally{f.close();}
});
test('db-check extra arguments fail before accessing a database',async()=>{
  const oldOpen=admin.openStore,oldPath=admin.requireDbPath;
  let opens=0;
  admin.openStore=()=>{opens++;throw Error('must not run');};
  admin.requireDbPath=()=>{opens++;throw Error('must not run');};
  try{await assert.rejects(cli.main(['db-check','--force']),/Usage: /);}
  finally{admin.openStore=oldOpen;admin.requireDbPath=oldPath;}
  assert.equal(opens,0);
});
