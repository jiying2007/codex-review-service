'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Worker}=require('node:worker_threads');
const {buildWorkerEnv}=require('../src/multi-gitlab-config');

function probe(env){
  // This is an embedded, network-free worker that cannot start Codex.
  const source=[
    "'use strict';",
    "const {parentPort}=require('node:worker_threads');",
    "parentPort.postMessage({home:process.env.HOME,",
    " tokenFile:process.env.GITLAB_API_TOKEN_FILE,",
    " hookFile:process.env.GITLAB_WEBHOOK_SIGNING_TOKEN_FILE,",
    " rawToken:process.env.GITLAB_API_TOKEN||null,",
    " parentKey:process.env.OPENAI_API_KEY||null,",
    " multiManifest:process.env.CODEX_REVIEW_MULTI_CONFIG_FILE||null});"
  ].join('\n');
  return new Promise((resolve,reject)=>{
    const worker=new Worker(source,{eval:true,env});
    worker.once('message',resolve);
    worker.once('error',reject);
    worker.once('exit',code=>{if(code!==0)reject(Error('Worker probe exited '+code));});
  });
}
test('real Worker Threads receive only their own scoped GitLab credential FILE identities',async()=>{
  const instances=[
    {id:'legacy',configFile:'/etc/codex-review/legacy.json',
      homeDir:'/home/codex-review/legacy',
      secretFiles:{
        GITLAB_API_TOKEN_FILE:'/run/secrets/gitlab_legacy_api',
        GITLAB_WEBHOOK_SIGNING_TOKEN_FILE:'/run/secrets/gitlab_legacy_webhook'
      }},
    {id:'sensor',configFile:'/etc/codex-review/sensor.json',
      homeDir:'/home/codex-review/sensor',
      secretFiles:{
        GITLAB_API_TOKEN_FILE:'/run/secrets/gitlab_sensor_api',
        GITLAB_WEBHOOK_SIGNING_TOKEN_FILE:'/run/secrets/gitlab_sensor_webhook'
      }}
  ];
  const parent={PATH:process.env.PATH,OPENAI_API_KEY:'parent-credential-not-visible',
    GITLAB_API_TOKEN:'shared-credential-not-visible',
    CODEX_REVIEW_MULTI_CONFIG_FILE:'/etc/codex-review/multi-instance.json'};
  const [legacy,sensor]=await Promise.all(instances.map(item=>probe(buildWorkerEnv(item,parent))));
  assert.equal(legacy.home,instances[0].homeDir);
  assert.equal(sensor.home,instances[1].homeDir);
  assert.equal(legacy.tokenFile,instances[0].secretFiles.GITLAB_API_TOKEN_FILE);
  assert.equal(sensor.tokenFile,instances[1].secretFiles.GITLAB_API_TOKEN_FILE);
  assert.notEqual(legacy.tokenFile,sensor.tokenFile);
  assert.notEqual(legacy.hookFile,sensor.hookFile);
  for(const result of [legacy,sensor]){
    assert.equal(result.rawToken,null);
    assert.equal(result.parentKey,null);
    assert.equal(result.multiManifest,null);
  }
});
