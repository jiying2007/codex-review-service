'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {inspectDatabase,inspectTenantDatabases}=require('../src/multi-gitlab-cutover-check');
const {contract}=require('../src/product-contract');

function dbFixture({schema=contract.databaseSchemaVersion}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'multi-gitlab-cutover-'));
  const filename=path.join(dir,'review-service.sqlite');
  const db=new DatabaseSync(filename);
  db.exec([
    'PRAGMA foreign_keys=ON;',
    'CREATE TABLE review_jobs(id INTEGER PRIMARY KEY,status TEXT NOT NULL);',
    'CREATE TABLE publication_outbox(id INTEGER PRIMARY KEY,status TEXT NOT NULL);',
    'CREATE TABLE notification_outbox(id INTEGER PRIMARY KEY,status TEXT NOT NULL);',
    'CREATE TABLE status_write_attempts(id INTEGER PRIMARY KEY,outcome TEXT NOT NULL);',
    'CREATE TABLE status_publication_targets(id INTEGER PRIMARY KEY,projection_state TEXT NOT NULL);',
    'PRAGMA user_version='+Number(schema)+';'
  ].join('\n'));
  const insert=(table,status)=>{
    const column=['status_write_attempts'].includes(table)?'outcome':
      table==='status_publication_targets'?'projection_state':'status';
    db.prepare('INSERT INTO '+table+'('+column+') VALUES(?)').run(status);
  };
  return{dir,db,file:filename,insert,close(){db.close();fs.rmSync(dir,{recursive:true,force:true});}};
}
test('non-mutating cutover checker admits a drained, compatible database',()=>{
  const f=dbFixture();
  try{
    f.insert('review_jobs','pass');
    f.insert('publication_outbox','published');
    f.insert('notification_outbox','delivered');
    f.insert('status_write_attempts','acknowledged');
    f.insert('status_publication_targets','published');
    const before=f.db.prepare('SELECT COUNT(*) AS count FROM review_jobs').get().count;
    const result=inspectDatabase(f.file);
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(result.code,'READY');
    assert.equal(result.drained,true);
    assert.equal(result.schemaVersion,contract.databaseSchemaVersion);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM review_jobs').get().count,before);
  }finally{f.close();}
});
test('cutover blocks every outstanding retry, worker claim and uncertain remote status',()=>{
  const cases=[
    ['review_jobs','queued','reviewJobs'],
    ['review_jobs','running','reviewJobs'],
    ['publication_outbox','pending','publications'],
    ['publication_outbox','uncertain','publications'],
    ['notification_outbox','delivering','notifications'],
    ['status_write_attempts','started','uncertainStatusWrites'],
    ['status_write_attempts','uncertain','uncertainStatusWrites'],
    ['status_publication_targets','uncertain','uncertainStatusTargets']
  ];
  for(const [table,status,field] of cases){
    const f=dbFixture();
    try{
      f.insert(table,status);
      const result=inspectDatabase(f.file);
      assert.equal(result.ok,false,table+': '+status);
      assert.equal(result.code,'EDBNOTDRAINED');
      assert.equal(result.active[field],1);
    }finally{f.close();}
  }
});
test('cutover refuses an old or unknown SQLite schema even when no work remains',()=>{
  for(const schema of [9,10,12,0]){
    const f=dbFixture({schema});
    try{
      const result=inspectDatabase(f.file);
      assert.equal(result.ok,false);
      assert.equal(result.code,'EDBSCHEMA');
      assert.equal(result.schemaVersion,schema);
    }finally{f.close();}
  }
});
test('cutover rejects absent and structurally incomplete files without creating a database',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'multi-gitlab-missing-'));
  const filename=path.join(dir,'missing.sqlite');
  try{
    const missing=inspectDatabase(filename);
    assert.deepEqual(missing,{ok:false,code:'EDBMISSING',schemaVersion:null,drained:false});
    assert.equal(fs.existsSync(filename),false);
    const db=new DatabaseSync(filename);
    db.exec('PRAGMA user_version='+contract.databaseSchemaVersion);
    db.close();
    assert.equal(inspectDatabase(filename).code,'EDBTABLES');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('startup cutover checks use the same frozen manifest, not a second mutable config read',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'multi-cutover-manifest-'));
  try{
    const locked={instances:[
      {id:'legacy',dataDir:path.join(dir,'legacy')},
      {id:'sensor',dataDir:path.join(dir,'sensor')}
    ]};
    const result=inspectTenantDatabases({
      manifestFile:path.join(dir,'absent-and-not-to-be-loaded.json'),
      manifest:locked
    });
    assert.equal(result.ok,false);
    assert.deepEqual(result.results.map(x=>x.id),['legacy','sensor']);
    assert.deepEqual(result.results.map(x=>x.code),['EDBMISSING','EDBMISSING']);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
