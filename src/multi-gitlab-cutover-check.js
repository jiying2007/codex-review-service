'use strict';
// Non-mutating cutover gate. Unlike Store() this must never migrate or recover
// the database and must not open a second SQLite writer.
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {loadMultiManifest}=require('./multi-gitlab-config');
const {contract}=require('./product-contract');

const TERMINAL_JOBS=Object.freeze([
  'pass','needs_attention','blocked','incomplete','failed',
  'superseded','cancelled','unauthorized','duplicate','skipped'
]);
const TERMINAL_PUBLICATIONS=Object.freeze(['published','failed','cancelled']);
const TERMINAL_NOTIFICATIONS=Object.freeze(['delivered','failed','cancelled']);

function countActive(db,table,terminal){
  const names=terminal.map(()=>'?').join(',');
  return Number(db.prepare('SELECT COUNT(*) AS count FROM '+table+
    ' WHERE status NOT IN ('+names+')').get(...terminal).count);
}
function inspectDatabase(dbPath,{open=(file)=>new DatabaseSync(file,{readOnly:true}),
    expectedSchema=contract.databaseSchemaVersion}={}){
  let stat;
  try{stat=fs.statSync(dbPath);}catch{
    return{ok:false,code:'EDBMISSING',schemaVersion:null,drained:false};
  }
  if(!stat.isFile())return{ok:false,code:'EDBNOTFILE',schemaVersion:null,drained:false};
  let db;
  try{
    db=open(dbPath);
    const pragma=db.prepare('PRAGMA quick_check').get();
    const integrity=pragma?.quick_check;
    const fk=db.prepare('PRAGMA foreign_key_check').all();
    const schemaVersion=Number(db.prepare('PRAGMA user_version').get().user_version);
    const tables=new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
    const required=['review_jobs','publication_outbox','notification_outbox'];
    if(required.some(name=>!tables.has(name)))
      return{ok:false,code:'EDBTABLES',schemaVersion,drained:false};
    const active={
      reviewJobs:countActive(db,'review_jobs',TERMINAL_JOBS),
      publications:countActive(db,'publication_outbox',TERMINAL_PUBLICATIONS),
      notifications:countActive(db,'notification_outbox',TERMINAL_NOTIFICATIONS),
      uncertainStatusWrites:tables.has('status_write_attempts')?
        Number(db.prepare("SELECT COUNT(*) AS count FROM status_write_attempts WHERE outcome IN ('started','uncertain')").get().count):0,
      uncertainStatusTargets:tables.has('status_publication_targets')?
        Number(db.prepare("SELECT COUNT(*) AS count FROM status_publication_targets WHERE projection_state='uncertain'").get().count):0
    };
    const drained=Object.values(active).every(value=>value===0);
    const schemaCompatible=schemaVersion===expectedSchema;
    const healthy=integrity==='ok'&&fk.length===0;
    const ok=drained&&schemaCompatible&&healthy;
    return{
      ok,code:!healthy?'EDBINTEGRITY':!schemaCompatible?'EDBSCHEMA':
        !drained?'EDBNOTDRAINED':'READY',
      schemaVersion,expectedSchema,drained,integrity:healthy,active
    };
  }catch(error){
    return{ok:false,code:String(error?.code||'EDBREAD').slice(0,72),drained:false};
  }finally{try{db?.close();}catch{}}
}
function inspectTenantDatabases({manifestFile,manifest,open}={}){
  const lockedManifest=manifest||loadMultiManifest(manifestFile);
  const results=lockedManifest.instances.map(tenant=>{
    const file=path.join(tenant.dataDir,'review-service.sqlite');
    return{id:tenant.id,...inspectDatabase(file,{open})};
  });
  return{ok:results.every(item=>item.ok),mode:'read-only',
    doesNotMigrate:true,doesNotStopOldWriters:true,results};
}
if(require.main===module){
  try{
    const result=inspectTenantDatabases();
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    if(!result.ok)process.exitCode=2;
  }catch(error){
    process.stderr.write(JSON.stringify({ok:false,code:String(error?.code||'EDBCUTOVER')})+'\n');
    process.exitCode=2;
  }
}
module.exports={
  inspectDatabase,inspectTenantDatabases,countActive,
  TERMINAL_JOBS,TERMINAL_PUBLICATIONS,TERMINAL_NOTIFICATIONS
};
