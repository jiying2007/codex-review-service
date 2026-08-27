#!/usr/bin/env python3
import json, pathlib, re
root=pathlib.Path('.')
CORE='c59a036cdb0b5839fe0e794031d38fd274bc116b'
OLD='a4a8acab6565bdb7e5f7927d2a4db14d31a6e895'

def read(p): return (root/p).read_text()
def write(p,s):
    q=root/p; q.parent.mkdir(parents=True,exist_ok=True); q.write_text(s)
def rep(p,a,b,count=1):
    s=read(p)
    if a not in s: raise SystemExit(f'missing marker in {p}: {a[:100]!r}')
    write(p,s.replace(a,b,count))
def loadj(p): return json.loads(read(p))
def savej(p,o): write(p,json.dumps(o,ensure_ascii=False,indent=2)+'\n')

# DB Schema 6: explicit 5->6 migration plus append-only human resolution history.
db=read('src/db.js')
db=db.replace("const { DatabaseSync } = require('node:sqlite');\n\nconst SCHEMA_VERSION = 5;","const { DatabaseSync } = require('node:sqlite');\nconst { CURRENT_SCHEMA_VERSION, FINDING_RESOLUTIONS, migrateDatabase } = require('./db-migrations');\n\nconst SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;",1)
db=db.replace("constructor(dbPath){fs.mkdirSync(path.dirname(dbPath),{recursive:true,mode:0o700});this.db=new DatabaseSync(dbPath);try{this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');this.initializeSchema();}catch(error){try{this.db.close();}catch{}throw error;}}",
"constructor(dbPath,{migrationHooks={}}={}){this.dbPath=dbPath;this.migrationHooks=migrationHooks;if(dbPath!==':memory:')fs.mkdirSync(path.dirname(dbPath),{recursive:true,mode:0o700});this.db=new DatabaseSync(dbPath);try{this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');this.initializeSchema();}catch(error){try{this.db.close();}catch{}throw error;}}",1)
old_init="""    if(current===SCHEMA_VERSION)return;
    if(current!==0||existing.length){const error=new Error(`Unsupported database schema ${current}; Codex Review Service first release requires a fresh Schema ${SCHEMA_VERSION} database`);error.code='EDBSCHEMA';throw error;}
    this.db.exec(`
"""
new_init="""    if(current===SCHEMA_VERSION)return;
    if(current===5){this.lastMigration=migrateDatabase(this.db,this.dbPath,current,this.migrationHooks);return;}
    if(current!==0||existing.length){const error=new Error(`Unsupported database schema ${current}; expected fresh database, Schema 5 migration source, or Schema ${SCHEMA_VERSION}`);error.code='EDBSCHEMA';throw error;}
    this.db.exec(`
"""
if old_init not in db: raise SystemExit('db initialize marker missing')
db=db.replace(old_init,new_init,1)
index_marker="    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_review_jobs_status_available"
fresh_extra="""    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL,backup_path TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS finding_resolutions(id INTEGER PRIMARY KEY AUTOINCREMENT,finding_id INTEGER NOT NULL REFERENCES review_findings(id) ON DELETE CASCADE,resolution TEXT NOT NULL CHECK(resolution IN ('fixed','false_positive','accepted_risk','duplicate','obsolete','not_applicable','policy_exception')),note TEXT NOT NULL DEFAULT '',actor TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_finding_resolutions_finding ON finding_resolutions(finding_id,id);
      CREATE INDEX IF NOT EXISTS idx_finding_resolutions_created ON finding_resolutions(created_at,id);
    `);
"""
if index_marker not in db: raise SystemExit('db index marker missing')
db=db.replace(index_marker,fresh_extra+index_marker,1)
# Record fresh schema provenance after the index/user_version statement.
needle="PRAGMA user_version=${SCHEMA_VERSION};`);\n  }"
if needle not in db: raise SystemExit('fresh schema version marker missing')
db=db.replace(needle,"PRAGMA user_version=${SCHEMA_VERSION};`);\n    this.db.prepare('INSERT OR REPLACE INTO schema_migrations(version,applied_at,backup_path) VALUES(?,?,?)').run(SCHEMA_VERSION,new Date().toISOString(),'fresh');\n  }",1)
methods="""  recordFindingResolution(findingId,resolution,{note='',actor=''}={}){const id=Number(findingId),value=String(resolution||'');if(!Number.isInteger(id)||id<=0){const error=new Error('findingId must be a positive integer');error.code='EFINDINGRESOLUTION';throw error;}if(!FINDING_RESOLUTIONS.includes(value)){const error=new Error(`Unsupported finding resolution: ${value}`);error.code='EFINDINGRESOLUTION';throw error;}const text=String(note||'').trim(),who=String(actor||'').trim();if(text.length>2000||who.length>255||/[\\r\\n\\0]/.test(who)){const error=new Error('Finding resolution metadata is invalid');error.code='EFINDINGRESOLUTION';throw error;}if(!this.db.prepare('SELECT id FROM review_findings WHERE id=?').get(id)){const error=new Error(`Finding ${id} does not exist`);error.code='EFINDINGNOTFOUND';throw error;}const result=this.db.prepare('INSERT INTO finding_resolutions(finding_id,resolution,note,actor,created_at) VALUES(?,?,?,?,?)').run(id,value,text,who,new Date().toISOString());return Number(result.lastInsertRowid);}
  findingResolutionHistory(findingId){return this.db.prepare('SELECT * FROM finding_resolutions WHERE finding_id=? ORDER BY id').all(Number(findingId));}
  latestFindingResolution(findingId){return this.db.prepare('SELECT * FROM finding_resolutions WHERE finding_id=? ORDER BY id DESC LIMIT 1').get(Number(findingId))||null;}
  resolutionMetrics(since=''){const rows=since?this.db.prepare('SELECT resolution,COUNT(*) count FROM finding_resolutions WHERE created_at>=? GROUP BY resolution ORDER BY resolution').all(String(since)):this.db.prepare('SELECT resolution,COUNT(*) count FROM finding_resolutions GROUP BY resolution ORDER BY resolution').all();return Object.freeze(Object.fromEntries(rows.map(row=>[row.resolution,Number(row.count)])));}
"""
if '  stats(){' not in db: raise SystemExit('db stats marker missing')
db=db.replace('  stats(){',methods+'  stats(){',1)
db=db.replace('module.exports={Store,SCHEMA_VERSION,TERMINAL_JOB_STATUSES,TERMINAL_PUBLICATION_STATUSES};','module.exports={Store,SCHEMA_VERSION,FINDING_RESOLUTIONS,TERMINAL_JOB_STATUSES,TERMINAL_PUBLICATION_STATUSES};',1)
write('src/db.js',db)

# Storage adapter becomes the only production construction boundary.
idx=read('src/index.js').replace("const { Store }=require('./db');","const { createStorage }=require('./storage');",1).replace('const store=new Store(config.dbPath),scheduler=installFairScheduling(store)','const store=createStorage({dbPath:config.dbPath}),scheduler=installFairScheduling(store)',1)
write('src/index.js',idx)
admin=read('src/admin.js').replace("const {Store,SCHEMA_VERSION}=require('./db');","const {SCHEMA_VERSION}=require('./db');\nconst {createStorage}=require('./storage');",1).replace('function openStore(){return new Store(requireDbPath());}','function openStore(){return createStorage({dbPath:requireDbPath()});}',1).replace('const store=new Store(config.dbPath),gitlab=new GitLabClient(config);','const store=createStorage({dbPath:config.dbPath}),gitlab=new GitLabClient(config);',1)
admin=admin.replace("function diagnostics(store){", "function resolveFinding(store,findingId,resolution,note='',actor='admin-cli'){const resolutionId=store.recordFindingResolution(findingId,resolution,{note,actor});return{findingId:Number(findingId),resolutionId,resolution,history:store.findingResolutionHistory(findingId)};}\nfunction resolutionMetrics(store,since=''){return store.resolutionMetrics(since);}\nfunction diagnostics(store){",1)
admin=admin.replace('module.exports={adminError,resolveDbPath,requireDbPath,openStore,rows,status,retryTerminal,verifyDatabase,createBackup,drain,reconcile,diagnostics};','module.exports={adminError,resolveDbPath,requireDbPath,openStore,rows,status,retryTerminal,verifyDatabase,createBackup,drain,reconcile,resolveFinding,resolutionMetrics,diagnostics};',1)
write('src/admin.js',admin)
cli=read('src/admin-cli.js')
cli=cli.replace('status|jobs|publications|notifications|retry-publication ID|retry-notification ID|drain [SECONDS]|reconcile|db-check|backup PATH|backup-verify PATH|restore-check PATH|diagnostics','status|jobs|publications|notifications|retry-publication ID|retry-notification ID|resolve-finding ID RESOLUTION [NOTE]|resolution-metrics [SINCE]|drain [SECONDS]|reconcile|db-check|backup PATH|backup-verify PATH|restore-check PATH|diagnostics')
cli=cli.replace("async function main(argv=process.argv.slice(2)){const [command,arg]=argv;", "async function main(argv=process.argv.slice(2)){const [command,arg,arg2,...rest]=argv;",1)
cli=cli.replace("if(command==='drain')return output(await admin.drain(store,arg||60));", "if(command==='resolve-finding'){if(!arg||!arg2)usage();return output(admin.resolveFinding(store,arg,arg2,rest.join(' ')));}if(command==='resolution-metrics')return output(admin.resolutionMetrics(store,arg||''));if(command==='drain')return output(await admin.drain(store,arg||60));",1)
write('src/admin-cli.js',cli)

# GitLab immutable HEAD tree acquisition for Impact Evidence.
gitlab=read('src/gitlab.js')
marker="async listOpenMergeRequests(projectId){return this.paginated(`/projects/${encodeProject(projectId)}/merge_requests`,{state:'opened',scope:'all'});}"
if marker not in gitlab: raise SystemExit('gitlab tree marker missing')
gitlab=gitlab.replace(marker,"async listRepositoryTree(projectId,ref){return this.paginated(`/projects/${encodeProject(projectId)}/repository/tree`,{ref,recursive:true});}\n"+marker,1)
write('src/gitlab.js',gitlab)

# Config: execution profile + pre-generated SARIF are operator config, never repository policy.
config=read('src/config.js')
config=config.replace("'manualReviewBypassAssignee'])","'manualReviewBypassAssignee','profile','sarifFiles'])",1)
helper="""function repositoryPaths(value,label){if(value===undefined)return[];if(!Array.isArray(value)||value.length>8)throw configError(`${label} must be an array with at most 8 paths`);const out=[];for(const raw of value){const item=stringValue(raw,'',label,512).replace(/\\\\/g,'/').replace(/^\\.\\//,'');if(!item||item.startsWith('/')||item.split('/').includes('..'))throw configError(`${label} contains an invalid repository-relative path`);if(!out.includes(item))out.push(item);}return out;}
"""
config=config.replace('function positiveIds(value,label){',helper+'function positiveIds(value,label){',1)
needle="const dataDir=path.resolve(stringValue(s.dataDir,defaultStateDir(),'server.dataDir',2048)),language=enumValue(r.language,'zh-CN','review.language',['zh-CN','en']),blockingSeverity=enumValue(r.blockingSeverity,'high','review.blockingSeverity',SEVERITIES),maxDiffBytes=intValue(r.maxDiffBytes,1024*1024,'review.maxDiffBytes',4096,4*1024*1024);"
repl="const dataDir=path.resolve(stringValue(s.dataDir,defaultStateDir(),'server.dataDir',2048)),language=enumValue(r.language,'zh-CN','review.language',['zh-CN','en']),reviewProfile=enumValue(r.profile,'standard','review.profile',['quick','standard','deep','security','embedded']),sarifFiles=Object.freeze(repositoryPaths(r.sarifFiles,'review.sarifFiles')),blockingSeverity=enumValue(r.blockingSeverity,'high','review.blockingSeverity',SEVERITIES),maxDiffBytes=intValue(r.maxDiffBytes,1024*1024,'review.maxDiffBytes',4096,4*1024*1024);"
if needle not in config: raise SystemExit('config return prelude marker missing')
config=config.replace(needle,repl,1)
config=config.replace('webhookMaxBodyBytes:intValue(w.maxBodyBytes,1024*1024,\'webhook.maxBodyBytes\',4096,10*1024*1024),language,runnerMode,','webhookMaxBodyBytes:intValue(w.maxBodyBytes,1024*1024,\'webhook.maxBodyBytes\',4096,10*1024*1024),language,reviewProfile,sarifFiles,runnerMode,',1)
write('src/config.js',config)

# Service Quality Platform: collect evidence once per immutable MR snapshot and feed bounded blocks into each chunk.
service=read('src/service.js')
if "./quality" not in service:
    service=service.replace("const{buildReviewContext}=require('./context');","const{buildReviewContext}=require('./context');\nconst{collectServiceQualityEvidence,qualityContextBlocks}=require('./quality');\nconst{resolveReviewProfile}=require('./codex-safe-core/quality-platform');",1)
service=service.replace("async reviewSnapshot(job,mr,fullDiffs,policy,controller,incremental=null){const fullSnapshot=", "async reviewSnapshot(job,mr,fullDiffs,policy,controller,incremental=null){const qualityEvidence=await collectServiceQualityEvidence(this.gitlab,mr,fullDiffs,this.config),profile=qualityEvidence.profile||resolveReviewProfile(this.config.reviewProfile||'standard');this.telemetry?.metrics.inc('codex_review_impact_nodes_total',qualityEvidence.impact?.nodes?.length||0);this.telemetry?.metrics.inc('codex_review_analyzer_findings_total',qualityEvidence.analyzerFindings?.length||0);const fullSnapshot=",1)
service=service.replace("const selection=selectChunksWithinByteBudget(reviewSnapshot.chunks,this.config.maxTotalDiffBytes||this.config.maxDiffBytes);", "const baseTotalBudget=this.config.maxTotalDiffBytes||this.config.maxDiffBytes,profileTotalBudget=Math.max(policy.maxDiffBytes,Math.floor(baseTotalBudget*profile.evidenceFactor)),selection=selectChunksWithinByteBudget(reviewSnapshot.chunks,profileTotalBudget);",1)
service=service.replace("const contextConfig=adaptiveContextConfig(this.config,policy,chunk),context=await this.contextFn(this.gitlab,mr,chunk,contextConfig);", "const contextConfig=adaptiveContextConfig(this.config,policy,chunk),profileContextConfig={...contextConfig,maxContextBytes:Math.floor(contextConfig.maxContextBytes*profile.contextFactor),maxContextFiles:Math.max(contextConfig.maxContextFiles?1:0,Math.floor(contextConfig.maxContextFiles*profile.contextFactor)),contextLines:Math.max(contextConfig.contextLines?1:0,Math.floor(contextConfig.contextLines*profile.contextFactor))},context=await this.contextFn(this.gitlab,mr,chunk,profileContextConfig);context.blocks=[...(context.blocks||[]),...qualityContextBlocks(qualityEvidence)];context.bytes=(context.bytes||0)+qualityContextBlocks(qualityEvidence).reduce((n,v)=>n+Buffer.byteLength(v,'utf8'),0);",1)
service=service.replace("if(this.config.mrMaxTokenBudget&&usageTotal(usage)+estimate.total>this.config.mrMaxTokenBudget)", "const effectiveMrTokenBudget=this.config.mrMaxTokenBudget?Math.max(1,Math.floor(this.config.mrMaxTokenBudget*profile.tokenFactor)):0;if(effectiveMrTokenBudget&&usageTotal(usage)+estimate.total>effectiveMrTokenBudget)",1)
service=service.replace("review.carriedFindingCount=incremental?.carriedFindings?.length||0;", "review.carriedFindingCount=incremental?.carriedFindings?.length||0;review.reviewProfile=profile.name;review.impactNodes=qualityEvidence.impact?.nodes?.length||0;review.impactBytes=qualityEvidence.impact?.bytes||0;review.analyzerFindingCount=qualityEvidence.analyzerFindings?.length||0;",1)
write('src/service.js',service)

# GenAI-native semantic metrics alongside legacy metric continuity.
telemetry=read('src/telemetry.js')
helper="""function genAiUsageAttributes(usage={},extra={}){return Object.freeze({'gen_ai.usage.input_tokens':Number(usage.inputTokens||0),'gen_ai.usage.cache_read.input_tokens':Number(usage.cachedInputTokens||0),'gen_ai.usage.cache_creation.input_tokens':Number(usage.cacheWriteInputTokens||0),'gen_ai.usage.output_tokens':Number(usage.outputTokens||0),'gen_ai.usage.reasoning.output_tokens':Number(usage.reasoningOutputTokens||0),...extra});}
"""
telemetry=telemetry.replace('class Metrics{',helper+'class Metrics{',1)
telemetry=telemetry.replace('module.exports={Telemetry,Metrics};','module.exports={Telemetry,Metrics,genAiUsageAttributes};',1)
write('src/telemetry.js',telemetry)
service=read('src/service.js')
service=service.replace("const crypto=require('node:crypto');", "const crypto=require('node:crypto');\nconst{genAiUsageAttributes}=require('./telemetry');",1)
old_record="recordUsage(usage={},estimated=0,riskScore=0){const metrics=this.telemetry?.metrics;if(!metrics)return;metrics.inc('codex_review_input_tokens_total',Number(usage.inputTokens||0));metrics.inc('codex_review_cached_input_tokens_total',Number(usage.cachedInputTokens||0));metrics.inc('codex_review_cache_write_input_tokens_total',Number(usage.cacheWriteInputTokens||0));metrics.inc('codex_review_output_tokens_total',Number(usage.outputTokens||0));metrics.inc('codex_review_reasoning_output_tokens_total',Number(usage.reasoningOutputTokens||0));metrics.observe('codex_review_chunk_estimated_tokens',Number(estimated||0),[1000,5000,10000,25000,50000,100000,250000]);metrics.observe('codex_review_chunk_risk_score',Number(riskScore||0),[1,2,4,6,8,10,15,20]);}"
new_record="recordUsage(usage={},estimated=0,riskScore=0){const metrics=this.telemetry?.metrics;if(!metrics)return;metrics.inc('codex_review_input_tokens_total',Number(usage.inputTokens||0));metrics.inc('codex_review_cached_input_tokens_total',Number(usage.cachedInputTokens||0));metrics.inc('codex_review_cache_write_input_tokens_total',Number(usage.cacheWriteInputTokens||0));metrics.inc('codex_review_output_tokens_total',Number(usage.outputTokens||0));metrics.inc('codex_review_reasoning_output_tokens_total',Number(usage.reasoningOutputTokens||0));const semantic=genAiUsageAttributes(usage);metrics.inc('gen_ai_usage_input_tokens_total',semantic['gen_ai.usage.input_tokens']);metrics.inc('gen_ai_usage_cache_read_input_tokens_total',semantic['gen_ai.usage.cache_read.input_tokens']);metrics.inc('gen_ai_usage_cache_creation_input_tokens_total',semantic['gen_ai.usage.cache_creation.input_tokens']);metrics.inc('gen_ai_usage_output_tokens_total',semantic['gen_ai.usage.output_tokens']);metrics.inc('gen_ai_usage_reasoning_output_tokens_total',semantic['gen_ai.usage.reasoning.output_tokens']);metrics.observe('codex_review_chunk_estimated_tokens',Number(estimated||0),[1000,5000,10000,25000,50000,100000,250000]);metrics.observe('codex_review_chunk_risk_score',Number(riskScore||0),[1,2,4,6,8,10,15,20]);}"
if old_record not in service: raise SystemExit('service recordUsage marker missing')
service=service.replace(old_record,new_record,1)
write('src/service.js',service)

# Product identity + exact Core + runtime package surface.
contract=loadj('product-contract.json')
contract.update({'serviceVersion':'5.2.0','databaseSchemaVersion':6,'safeCoreCommit':CORE,'qualityPlatformVersion':1,'reviewProfileVersion':1,'impactEvidenceVersion':1,'analyzerFindingVersion':1})
savej('product-contract.json',contract)
pkg=loadj('package.json');pkg['version']='5.2.0'
for item in ['docs/PRODUCT_CONTRACT.md','docs/QUALITY_PLATFORM.md','docs/QUALITY_PLATFORM.zh-CN.md','docs/STORAGE_AND_MIGRATIONS.md','src/codex-safe-core/quality-platform.js']:
    if item not in pkg['files']: pkg['files'].append(item)
pkg['scripts']['docs:generate']='node scripts/generate-contract-docs.js'
pkg['scripts']['docs:verify']='node scripts/generate-contract-docs.js && git diff --exit-code -- docs/ARCHITECTURE.md docs/PRODUCT_CONTRACT.md'
pkg['scripts']['check']=pkg['scripts']['check'].replace('node scripts/verify-product-contract.js','node scripts/verify-product-contract.js && npm run docs:verify',1)
savej('package.json',pkg)

# Config examples: profile and SARIF files, same Config Schema v1.
for p in ['config.example.json','deploy/systemd/config.example.json','deploy/docker/config.example.json']:
    d=loadj(p);r=d.setdefault('review',{});r['profile']='standard';r['sarifFiles']=[];savej(p,d)
rep('.codex-safe.example.json',OLD,CORE)

# Architecture generated block replaces hand-maintained version facts.
arch=read('docs/ARCHITECTURE.md')
start=arch.index('Codex Review Service **')
end=arch.index('\n\nService-owned responsibilities:',start)
generated='<!-- BEGIN GENERATED PRODUCT CONTRACT -->\nplaceholder\n<!-- END GENERATED PRODUCT CONTRACT -->'
arch=arch[:start]+generated+arch[end:]
write('docs/ARCHITECTURE.md',arch)

# Product docs for new operational contract.
write('docs/QUALITY_PLATFORM.md',"""# Quality Platform\n\nService 5.2 consumes Safe Core 4.4 review profiles, Impact Evidence and SARIF normalization. Profiles are operator execution preferences, not repository policy. Impact candidates come from the exact MR head SHA through GitLab repository APIs; SARIF files must already exist in the repository at that same SHA. The Service never executes repository-defined analyzer commands.\n\nHuman finding resolutions are append-only operational feedback (`fixed`, `false_positive`, `accepted_risk`, `duplicate`, `obsolete`, `not_applicable`, `policy_exception`). They are observable metrics only and never auto-train a model or mutate prompts.\n""")
write('docs/QUALITY_PLATFORM.zh-CN.md',"""# 质量平台\n\nService 5.2 使用 Safe Core 4.4 的 Review Profile、Impact Evidence 与 SARIF 归一化能力。Profile 是运维侧执行偏好，不属于仓库 Policy。Impact 候选只通过 GitLab Repository API 从 MR 精确 head SHA 获取；SARIF 也必须已经存在于同一 SHA 的仓库中。Service 绝不执行仓库定义的 analyzer 命令。\n\n人工 finding resolution 采用 append-only 历史：`fixed`、`false_positive`、`accepted_risk`、`duplicate`、`obsolete`、`not_applicable`、`policy_exception`。这些反馈只进入可观测指标，绝不会自动训练模型或动态修改 Prompt。\n""")
write('docs/STORAGE_AND_MIGRATIONS.md',"""# Storage and migrations\n\nSchema 6 establishes the production migration framework. Schema 5 upgrades run `integrity_check`, create a mode-0600 SQLite `VACUUM INTO` backup, execute one `BEGIN IMMEDIATE` migration, set `user_version=6`, commit, then run another integrity check. Failure rolls the live DB transaction back and reports the verified backup path. Unsupported historical versions fail closed.\n\nSQLite WAL + FULL remains the only shipped backend. `src/storage.js` is the explicit replacement boundary. HA is recommended only after governed thresholds (over 100 repositories, over 20 Codex workers, over 100k reviews/day, cross-AZ requirement, or zero single-node downtime requirement). PostgreSQL/Redis/Kafka are intentionally not bundled before those requirements exist.\n""")

# Verify contract now governs quality identities and no stale Schema 5 current facts.
verify=read('scripts/verify-product-contract.js')
verify=verify.replace("assert.equal(core.REVIEW_RECEIPT_SCHEMA_VERSION,contract.reviewReceiptVersion,'Review Receipt schema must match product contract');","assert.equal(core.REVIEW_RECEIPT_SCHEMA_VERSION,contract.reviewReceiptVersion,'Review Receipt schema must match product contract');\nassert.equal(core.CORE_CONTRACT.qualityPlatformVersion,contract.qualityPlatformVersion,'Quality Platform must match product contract');\nassert.equal(core.CORE_CONTRACT.reviewProfileVersion,contract.reviewProfileVersion,'Review Profile must match product contract');\nassert.equal(core.CORE_CONTRACT.impactEvidenceVersion,contract.impactEvidenceVersion,'Impact Evidence must match product contract');\nassert.equal(core.CORE_CONTRACT.analyzerFindingVersion,contract.analyzerFindingVersion,'Analyzer Finding contract must match product contract');",1)
verify=verify.replace("assert.doesNotMatch(text,/SQLite schema 4|SQLite Schema 4|Schema 4 database|schema 4\\b/i", "assert.doesNotMatch(text,/SQLite schema [45]\\b|SQLite Schema [45]\\b|Schema [45] database|schema [45]\\b/i",1)
write('scripts/verify-product-contract.js',verify)

# Generate canonical docs after product contract/core are in the working tree.
# The finalizer workflow invokes npm docs generator after Core repin.

# Changelog.
ch=read('CHANGELOG.md')
if '## 5.2.0 - 2026-08-27' not in ch:
    ch=ch.replace('## Unreleased\n','## Unreleased\n\n## 5.2.0 - 2026-08-27\n\n- Add explicit SQLite Schema 5 -> 6 migration with pre/post integrity checks, durable backup and fault-tested transactional rollback.\n- Add append-only human finding-resolution history and Admin CLI metrics without automatic prompt/model learning.\n- Adopt Safe Core 4.4 operator review profiles, exact-head Impact Evidence, pre-generated SARIF evidence and GenAI semantic token telemetry.\n- Add a real storage replacement boundary and governed HA thresholds while intentionally keeping SQLite as the only shipped backend.\n- Generate human product-contract facts from machine contracts to eliminate version/Core/DB documentation drift.\n',1)
write('CHANGELOG.md',ch)
