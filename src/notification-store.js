'use strict';

const { planNotificationActions }=require('./notification');
const NOTIFICATION_SCHEMA_VERSION=1;
function json(value){return JSON.stringify(value??null);}
function parseJson(value){try{return JSON.parse(value);}catch{return null;}}
function isoAfter(ms){return new Date(Date.now()+Math.max(0,ms)).toISOString();}
function installNotificationStore(store,config){
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS service_extension_schema(name TEXT PRIMARY KEY,version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS notification_outbox(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER REFERENCES review_runs(id) ON DELETE CASCADE,
      project_id INTEGER NOT NULL DEFAULT 0,
      mr_iid INTEGER NOT NULL DEFAULT 0,
      route_name TEXT NOT NULL,
      provider TEXT NOT NULL,
      secret_ref TEXT NOT NULL,
      event_type TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      remote_id TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notification_status_available ON notification_outbox(status,available_at,id);
    CREATE INDEX IF NOT EXISTS idx_notification_run ON notification_outbox(run_id,id);
  `);
  store.db.prepare('INSERT INTO service_extension_schema(name,version) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET version=excluded.version').run('notifications',NOTIFICATION_SCHEMA_VERSION);
  store.notificationConfig=config;
  store.setNotificationConfig=next=>{store.notificationConfig=next;};
  store.notificationSchemaVersion=()=>Number(store.db.prepare("SELECT version FROM service_extension_schema WHERE name='notifications'").get()?.version||0);
  store.notificationDepth=()=>Number(store.db.prepare("SELECT COUNT(*) count FROM notification_outbox WHERE status='pending'").get().count);
  store.recoverNotifications=()=>store.db.prepare("UPDATE notification_outbox SET status='pending',started_at=NULL,error_code='ESERVICERESTART',available_at=? WHERE status='delivering'").run(new Date().toISOString()).changes;
  store.claimNotification=()=>store.withTransaction(()=>{const now=new Date().toISOString(),row=store.db.prepare("SELECT * FROM notification_outbox WHERE status='pending' AND available_at<=? ORDER BY id LIMIT 1").get(now);if(!row)return null;const result=store.db.prepare("UPDATE notification_outbox SET status='delivering',started_at=?,attempt=attempt+1 WHERE id=? AND status='pending'").run(now,row.id);if(result.changes!==1)return null;const value=store.db.prepare('SELECT * FROM notification_outbox WHERE id=?').get(row.id);value.payload=parseJson(value.payload_json);return value;});
  store.enqueueNotification=({runId=null,routeName,provider,secretRef,eventType,dedupeKey,payload,delayMs=0})=>{const now=new Date().toISOString();try{const result=store.db.prepare("INSERT INTO notification_outbox(run_id,project_id,mr_iid,route_name,provider,secret_ref,event_type,dedupe_key,payload_json,status,available_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)").run(runId,payload?.projectId||0,payload?.mrIid||0,routeName,provider,secretRef,eventType,dedupeKey,json(payload),isoAfter(delayMs),now);return Number(result.lastInsertRowid);}catch(error){if(String(error.message).includes('UNIQUE constraint failed'))return null;throw error;}};
  store.finishNotification=(id,remoteId=null)=>store.db.prepare("UPDATE notification_outbox SET status='delivered',remote_id=?,error_code=NULL,finished_at=? WHERE id=?").run(remoteId,new Date().toISOString(),id);
  store.retryNotification=(id,errorCode,delayMs)=>store.db.prepare("UPDATE notification_outbox SET status='pending',error_code=?,started_at=NULL,available_at=? WHERE id=? AND status='delivering'").run(errorCode,isoAfter(delayMs),id);
  store.failNotification=(id,errorCode)=>store.db.prepare("UPDATE notification_outbox SET status='failed',error_code=?,finished_at=? WHERE id=?").run(errorCode,new Date().toISOString(),id);

  store.saveRunWithOutbox=(jobId,review,durationMs,policy,actions,receiptProjection=null)=>store.withTransaction(()=>{
    const usage=review.usage||{},run=store.db.prepare(`INSERT INTO review_runs(job_id,verdict,summary,coverage_complete,finding_count,codex_version,codex_model,duration_ms,created_at,policy_source,policy_fingerprint,chunk_count,rejected_finding_count,truncated_finding_count,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,receipt_json,receipt_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(jobId,review.verdict,review.summary,review.coverageComplete?1:0,review.findings.length,review.codexVersion||null,review.codexModel||'',durationMs,new Date().toISOString(),policy.source,policy.fingerprint,review.chunkCount||0,review.rejectedFindingCount||0,review.truncatedFindingCount||0,usage.inputTokens||0,usage.cachedInputTokens||0,usage.cacheWriteInputTokens||0,usage.outputTokens||0,usage.reasoningOutputTokens||0,receiptProjection?json(receiptProjection.receipt):'',receiptProjection?.fingerprint||''),runId=Number(run.lastInsertRowid),insertFinding=store.db.prepare(`INSERT INTO review_findings(run_id,fingerprint,severity,category,file,line,end_line,title,description,suggestion,confidence,side,anchor_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for(const f of review.findings)insertFinding.run(runId,f.fingerprint,f.severity,f.category,f.file,f.line,f.endLine,f.title,f.description,f.suggestion,f.confidence,f.side,f.anchorHash||'');
    const insertAction=store.db.prepare("INSERT OR IGNORE INTO publication_outbox(run_id,project_id,mr_iid,action_type,dedupe_key,payload_json,status,available_at,created_at) VALUES(?,?,?,?,?,?,'pending',?,?)"),now=new Date().toISOString();for(const action of actions||[])insertAction.run(runId,action.projectId,action.mrIid,action.type,action.dedupeKey,json(action.payload),now,now);
    const job=store.getJob(jobId),event={type:review.verdict==='block'||review.verdict==='incomplete'?'review.blocked':'review.completed',projectId:Number(job?.project_id||0),mrIid:Number(job?.mr_iid||0),title:'',url:'',author:'',sourceBranch:String(job?.source_branch||''),targetBranch:'',headSha:String(job?.head_sha||''),verdict:String(review.verdict||''),coverageComplete:review.coverageComplete!==false,findingCounts:{critical:0,high:0,medium:0,low:0,info:0},findingCount:review.findings.length,topFindings:review.findings.slice(0,store.notificationConfig?.notificationTopFindings??3).map(f=>({severity:f.severity,title:f.title,file:f.file,line:f.line})),durationMs:Number(durationMs||0)};for(const f of review.findings)if(Object.hasOwn(event.findingCounts,f.severity))event.findingCounts[f.severity]++;
    const notify=store.db.prepare("INSERT OR IGNORE INTO notification_outbox(run_id,project_id,mr_iid,route_name,provider,secret_ref,event_type,dedupe_key,payload_json,status,available_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)");for(const action of planNotificationActions(store.notificationConfig,event,`run:${runId}:${event.headSha}`))notify.run(runId,event.projectId,event.mrIid,action.routeName,action.provider,action.secretRef,action.eventType,action.dedupeKey,json(action.payload),now,now);return runId;
  });
  const originalFinishJob=store.finishJob.bind(store);
  store.finishJob=(id,status,errorCode=null)=>{const result=originalFinishJob(id,status,errorCode);if(status==='failed'){const job=store.getJob(id),event={type:'review.failed',projectId:Number(job?.project_id||0),mrIid:Number(job?.mr_iid||0),title:'',url:'',author:'',sourceBranch:String(job?.source_branch||''),targetBranch:'',headSha:String(job?.head_sha||''),verdict:'failed',coverageComplete:false,findingCounts:{critical:0,high:0,medium:0,low:0,info:0},findingCount:0,topFindings:[],durationMs:0,errorCode:String(errorCode||'EUNKNOWN')};for(const action of planNotificationActions(store.notificationConfig,event,`job:${id}`))store.enqueueNotification(action);}return result;};
  const originalStats=store.stats.bind(store);
  store.stats=()=>{const base=originalStats(),notifications=Object.fromEntries(store.db.prepare('SELECT status,COUNT(*) count FROM notification_outbox GROUP BY status').all().map(row=>[row.status,Number(row.count)]));return{...base,notifications,notificationSchemaVersion:store.notificationSchemaVersion()};};
  return store;
}
module.exports={installNotificationStore,NOTIFICATION_SCHEMA_VERSION};
