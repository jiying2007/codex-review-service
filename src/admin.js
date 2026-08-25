'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {backup,DatabaseSync}=require('node:sqlite');
const {Store,SCHEMA_VERSION}=require('./db');
const {loadStructuredConfig,loadConfig,defaultStateDir}=require('./config');
const {GitLabClient}=require('./gitlab');
const {ProjectScopeManager,applyProjectScope}=require('./project-scope');
const {ReviewService}=require('./service');
const {prepareNotificationRoutes}=require('./notification');
const {contract}=require('./product-contract');

function adminError(message,code='EADMIN'){const error=new Error(message);error.code=code;return error;}
function resolveDbPath(){const structured=loadStructuredConfig(),raw=String(structured.value.server?.dataDir||'').trim(),dataDir=path.resolve(raw||defaultStateDir());return path.join(dataDir,'review-service.sqlite');}
function requireDbPath(){const dbPath=resolveDbPath();if(!fs.existsSync(dbPath))throw adminError(`Database does not exist: ${dbPath}`,'EADMINDB');return dbPath;}
function openStore(){return new Store(requireDbPath());}
function rows(store,table,limit=50){const allowed=new Set(['review_jobs','publication_outbox','notification_outbox']);if(!allowed.has(table))throw adminError('Unsupported admin table');const n=Math.max(1,Math.min(500,Number(limit)||50));return store.db.prepare(`SELECT * FROM ${table} ORDER BY id DESC LIMIT ?`).all(n);}
function status(store){const stats=store.stats(),oldest=table=>store.db.prepare(`SELECT MIN(created_at) created_at FROM ${table}`).get()?.created_at||null;return{product:contract,database:{path:store.db.location?.()||requireDbPath(),schemaVersion:store.schemaVersion(),synchronous:store.synchronousMode(),quickCheck:store.db.prepare('PRAGMA quick_check').get()?.quick_check||'unknown'},stats,oldest:{job:oldest('review_jobs'),publication:oldest('publication_outbox'),notification:oldest('notification_outbox')}};}
function retryTerminal(store,kind,id){const now=new Date().toISOString(),table=kind==='publication'?'publication_outbox':'notification_outbox',result=store.db.prepare(`UPDATE ${table} SET status='pending',attempt=0,error_code='EADMINRETRY',started_at=NULL,finished_at=NULL,available_at=? WHERE id=? AND status='failed'`).run(now,Number(id));if(Number(result.changes)!==1)throw adminError(`${kind} ${id} is not in failed state`,'EADMINSTATE');return{kind,id:Number(id),status:'pending'};}
function verifyDatabase(file){const target=path.resolve(file),db=new DatabaseSync(target,{readOnly:true});try{const quick=db.prepare('PRAGMA quick_check').get()?.quick_check||'unknown',foreign=db.prepare('PRAGMA foreign_key_check').all(),schema=Number(db.prepare('PRAGMA user_version').get().user_version||0);return{path:target,quickCheck:quick,foreignKeyViolations:foreign.length,schemaVersion:schema,compatible:quick==='ok'&&foreign.length===0&&schema===SCHEMA_VERSION};}finally{db.close();}}
async function createBackup(store,destination){const target=path.resolve(destination);if(target===path.resolve(requireDbPath()))throw adminError('Backup destination must differ from the live database');if(fs.existsSync(target))throw adminError(`Backup destination already exists: ${target}`,'EADMINEXISTS');fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});const pages=await backup(store.db,target);const verification=verifyDatabase(target);if(!verification.compatible){try{fs.unlinkSync(target);}catch{}throw adminError('Backup verification failed','EADMINBACKUP');}return{...verification,pages};}
async function drain(store,timeoutSeconds=60){const deadline=Date.now()+Math.max(1,Number(timeoutSeconds)||60)*1000;for(;;){const stats=store.stats(),pending=(stats.jobs.queued||0)+(stats.jobs.running||0)+(stats.publications.pending||0)+(stats.publications.publishing||0)+(stats.notifications.pending||0)+(stats.notifications.delivering||0);if(!pending)return{drained:true,stats};if(Date.now()>=deadline)return{drained:false,pending,stats};await new Promise(resolve=>setTimeout(resolve,500));}}
async function reconcile(){let config=loadConfig();const store=new Store(config.dbPath),gitlab=new GitLabClient(config);try{const manager=new ProjectScopeManager(gitlab,config);await manager.refresh();config=applyProjectScope(config,manager);config=await prepareNotificationRoutes(gitlab,config);const service=new ReviewService({config,store,gitlab,logger:{info(){},warn(){},error(){}}});return await service.reconcile();}finally{store.close();}}
function diagnostics(store){const s=status(store);return{serviceVersion:contract.serviceVersion,node:process.version,platform:process.platform,arch:process.arch,database:{schemaVersion:s.database.schemaVersion,synchronous:s.database.synchronous,quickCheck:s.database.quickCheck},counts:{jobs:s.stats.jobs,publications:s.stats.publications,notifications:s.stats.notifications,webhooks:s.stats.webhookCount,findings:s.stats.findings}};}
module.exports={adminError,resolveDbPath,requireDbPath,openStore,rows,status,retryTerminal,verifyDatabase,createBackup,drain,reconcile,diagnostics};
