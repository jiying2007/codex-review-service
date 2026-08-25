'use strict';

const { loadConfig }=require('./config');
const { Store }=require('./db');
const { installFairScheduling }=require('./fair-scheduler');
const { GitLabClient }=require('./gitlab');
const { applyGitLabCapabilities }=require('./gitlab-capabilities');
const { ProjectScopeManager,applyProjectScope }=require('./project-scope');
const { ReviewService }=require('./service');
const { Publisher }=require('./publication');
const { Notifier,prepareNotificationRoutes,systemEvent,planNotificationActions }=require('./notification');
const { Telemetry }=require('./telemetry');
const { createHttpServer }=require('./http');
const { probeCodexCapabilities }=require('./codex');
const { contract }=require('./product-contract');

function log(level,value){const record=typeof value==='object'&&value?value:{message:String(value)};process.stdout.write(`${JSON.stringify({ts:new Date().toISOString(),level,...record})}\n`);}
async function listen(server,port,host){await new Promise((resolve,reject)=>{const onError=e=>{server.off('listening',onListening);reject(e);},onListening=()=>{server.off('error',onError);resolve();};server.once('error',onError);server.once('listening',onListening);server.listen(port,host);});}

async function main(){
  const startedAt=Date.now();let config=loadConfig();
  const logger={info:v=>log('info',v),warn:v=>log('warn',v),error:v=>log('error',v)};
  const telemetry=new Telemetry({logger,endpoint:config.otelEndpoint,serviceName:config.otelServiceName,timeoutMs:config.otelExportTimeoutMs});
  const capability=await probeCodexCapabilities(config);logger.info({event:'codex_ready',mode:config.runnerMode,version:capability.version,versionMatched:capability.versionMatched,runnerCapability:capability.runnerCapability||null});if(capability.versionMatched===false)logger.warn({event:'codex_version_policy_warning',version:capability.version});
  const store=new Store(config.dbPath),scheduler=installFairScheduling(store),recoveredJobs=store.recoverInterruptedJobs(),recoveredPublications=store.recoverPublications(),recoveredNotifications=store.recoverNotifications();
  if(recoveredJobs)logger.info({event:'jobs_recovered',count:recoveredJobs});if(recoveredPublications)logger.info({event:'publications_recovered',count:recoveredPublications});if(recoveredNotifications)logger.info({event:'notifications_recovered',count:recoveredNotifications});
  const gitlab=new GitLabClient(config),gitlabVersion=await gitlab.getVersion(),gitlabCapabilities=await gitlab.getCapabilities();config=applyGitLabCapabilities(config,gitlabCapabilities);gitlab.config=config;
  logger.info({event:'gitlab_capabilities_ready',version:gitlabVersion.version,profile:gitlabCapabilities.profile,webhookAuth:gitlabCapabilities.webhookAuth,diffCompleteness:gitlabCapabilities.diffCompleteness});
  const scopeManager=new ProjectScopeManager(gitlab,config);await scopeManager.refresh();config=applyProjectScope(config,scopeManager);config=await prepareNotificationRoutes(gitlab,config);logger.info({event:'project_scope_ready',mode:scopeManager.mode,...scopeManager.stats,notificationRoutes:config.notificationRoutesResolved.length});
  const service=new ReviewService({config,store,gitlab,logger,telemetry}),publisher=new Publisher({config,store,gitlab,logger}),notifier=new Notifier({config,store,logger});service.startWorkers();publisher.start();notifier.start();
  const server=createHttpServer({config,store,service,publisher,notifier,gitlab,telemetry,logger,startedAt});await listen(server,config.port,config.host);logger.info({event:'service_started',serviceVersion:contract.serviceVersion,configSchemaVersion:contract.configSchemaVersion,databaseSchemaVersion:store.schemaVersion(),safeCoreCommit:contract.safeCoreCommit,gitlabVersion:gitlabCapabilities.version,gitlabProfile:gitlabCapabilities.profile,webhookAuth:gitlabCapabilities.webhookAuth,host:config.host,port:config.port,deployment:config.runnerMode==='isolated'?'hardened':'standard',workers:config.workerConcurrency,publishers:config.publisherConcurrency,notifiers:config.notificationEnabled?config.notificationConcurrency:0,synchronous:store.synchronousMode(),scheduler:'project-fair'});
  const maintenance=setInterval(()=>{try{const pruned=store.prune(config);store.checkpoint();if(pruned.webhooks||pruned.jobs)logger.info({event:'data_pruned',...pruned});}catch(error){logger.warn({event:'maintenance_failed',code:error.code||'EMAINTENANCE'});}},config.maintenanceIntervalMs);maintenance.unref?.();
  const reconcileOnce=()=>service.reconcile().then(result=>{if(result.enqueued)logger.info({event:'reconcile_enqueued',...result});}).catch(error=>logger.warn({event:'reconcile_failed',code:error.code||'ERECONCILE'}));
  const enqueueSystem=event=>{for(const action of planNotificationActions(config,event,`system:${event.type}:${Date.now()}`))store.enqueueNotification(action);};let scopeWasHealthy=true;
  const periodic=()=>config.gitlabGroups.length?scopeManager.refresh().then(async snapshot=>{config=applyProjectScope(config,scopeManager);config=await prepareNotificationRoutes(gitlab,config);service.config=config;publisher.config=config;notifier.refreshConfig(config);if(!scopeWasHealthy){enqueueSystem(systemEvent('service.recovered',{component:'project_scope'}));scopeWasHealthy=true;}logger.info({event:'project_scope_refreshed',mode:snapshot.mode,totalProjects:snapshot.totalProjects,discoveredProjects:snapshot.discoveredProjects,notificationRoutes:config.notificationRoutesResolved.length});return reconcileOnce();}).catch(error=>{if(scopeWasHealthy){enqueueSystem(systemEvent('service.degraded',{component:'project_scope',code:error.code||'EPROJECTSCOPE'}));scopeWasHealthy=false;}logger.error({event:'project_scope_refresh_failed',code:error.code||'EPROJECTSCOPE'});}):reconcileOnce();
  const reconcile=setInterval(periodic,config.reconcileIntervalMs);reconcile.unref?.();setTimeout(()=>reconcileOnce(),Math.min(5000,config.pollIntervalMs)).unref?.();
  let shuttingDown=false;const shutdown=async signal=>{if(shuttingDown)return;shuttingDown=true;logger.info({event:'shutdown',signal,scheduler:scheduler.snapshot()});clearInterval(maintenance);clearInterval(reconcile);await new Promise(resolve=>server.close(resolve));await service.stop();await publisher.stop();await notifier.stop();await telemetry.flush();store.checkpoint();store.close();};
  let fatalExitStarted=false;const fatal=async(kind,error)=>{if(fatalExitStarted)return;fatalExitStarted=true;logger.error({event:'fatal_runtime_error',kind,code:error?.code||'EUNHANDLED',message:String(error?.message||error||'unknown').slice(0,500)});try{await shutdown(kind);}catch(shutdownError){logger.error({event:'fatal_shutdown_failed',code:shutdownError?.code||'ESHUTDOWN'});}process.exit(1);};
  process.on('SIGTERM',()=>{shutdown('SIGTERM').catch(()=>process.exit(1));});process.on('SIGINT',()=>{shutdown('SIGINT').catch(()=>process.exit(1));});process.on('unhandledRejection',error=>{fatal('unhandledRejection',error).catch(()=>process.exit(1));});process.on('uncaughtException',error=>{fatal('uncaughtException',error).catch(()=>process.exit(1));});
}
main().catch(error=>{log('error',{event:'startup_failed',code:error.code||'ESTART',message:error.message});process.exitCode=1;});
