'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {loadMultiManifest,buildWorkerEnv,overlaps}=require('../src/multi-gitlab-config');

function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'multi-gitlab-config-'));
  function location(name){return path.join(dir,name);}
  function write(name,content){const file=location(name);fs.writeFileSync(file,content);return file;}
  const tokens={
    legacyApi:write('legacy-api','legacy-api-credential'),
    legacyWebhook:write('legacy-hook','whsec_'+Buffer.alloc(32,3).toString('base64')),
    sensorApi:write('sensor-api','sensor-api-credential'),
    sensorWebhook:write('sensor-hook','whsec_'+Buffer.alloc(32,4).toString('base64'))
  };
  const makeConfig=(id,host,projects)=>({
    schemaVersion:8,server:{host:'127.0.0.1',port:8787,dataDir:location(id+'-db')},
    gitlab:{baseUrl:host,projects,groups:[]},
    webhook:{expectedInstance:host,requireInstanceHeader:true},
    review:{triggerAssignment:{mode:id==='sensor'?'always':'assignee',userIds:id==='sensor'?[]:[8]}}
  });
  const legacy=makeConfig('legacy','http://192.168.1.4',[113,139]);
  const sensor=makeConfig('sensor','http://192.168.2.50',[113]);
  const manifest={
    schemaVersion:1,server:{host:'127.0.0.1',port:8788,defaultInstance:'legacy',sharedProcessTrustAcknowledged:true},
    instances:[
      {id:'legacy',configFile:location('legacy.json'),homeDir:location('legacy-home'),
        secretFiles:{GITLAB_API_TOKEN_FILE:tokens.legacyApi,GITLAB_WEBHOOK_SIGNING_TOKEN_FILE:tokens.legacyWebhook}},
      {id:'sensor',configFile:location('sensor.json'),homeDir:location('sensor-home'),
        secretFiles:{GITLAB_API_TOKEN_FILE:tokens.sensorApi,GITLAB_WEBHOOK_SIGNING_TOKEN_FILE:tokens.sensorWebhook}}
    ]
  };
  const manifestFile=location('multi.json');
  const flush=()=>{
    fs.writeFileSync(manifest.instances[0].configFile,JSON.stringify(legacy));
    fs.writeFileSync(manifest.instances[1].configFile,JSON.stringify(sensor));
    fs.writeFileSync(manifestFile,JSON.stringify(manifest));
  };
  flush();
  return {dir,location,manifest,legacy,sensor,tokens,manifestFile,flush,
    close:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('two GitLab servers may have identical project 113 but never share durable identity',()=>{
  const f=fixture();try{
    const config=loadMultiManifest(f.manifestFile);
    assert.equal(config.instances.length,2);
    assert.equal(config.server.defaultInstance,'legacy');
    assert.equal(config.instances[0].origin,'http://192.168.1.4');
    assert.equal(config.instances[1].origin,'http://192.168.2.50');
    assert.ok(f.legacy.gitlab.projects.includes(113));
    assert.ok(f.sensor.gitlab.projects.includes(113));
    assert.notEqual(config.instances[0].dataDir,config.instances[1].dataDir);
    assert.notEqual(config.instances[0].homeDir,config.instances[1].homeDir);
    assert.equal(overlaps(config.instances[0].dataDir,config.instances[1].dataDir),false);
  }finally{f.close();}
});

test('legacy Config Schema 8 may omit either optional scope array without changing project identity',()=>{
  const f=fixture();try{
    delete f.legacy.gitlab.groups;
    f.sensor.gitlab.projects=undefined;
    f.sensor.gitlab.groups=[{id:48,includeSubgroups:false}];
    f.flush();
    const loaded=loadMultiManifest(f.manifestFile);
    assert.equal(loaded.instances.length,2);
    assert.equal(loaded.instances[0].origin,'http://192.168.1.4');
    assert.equal(loaded.instances[1].origin,'http://192.168.2.50');
  }finally{f.close();}
});

test('worker environments retain only their own secret file paths and runtime homes',()=>{
  const f=fixture();try{
    const c=loadMultiManifest(f.manifestFile);
    const parent={PATH:'/usr/bin',GITLAB_API_TOKEN:'do-not-inherit',
      GITLAB_WEBHOOK_SIGNING_TOKEN:'do-not-inherit',OPENAI_API_KEY:'do-not-inherit',
      CODEX_REVIEW_MULTI_CONFIG_FILE:f.manifestFile,CODEX_HOME:'/shared'};
    const old=buildWorkerEnv(c.instances[0],parent),sensor=buildWorkerEnv(c.instances[1],parent);
    assert.equal(old.GITLAB_API_TOKEN_FILE,f.tokens.legacyApi);
    assert.equal(sensor.GITLAB_API_TOKEN_FILE,f.tokens.sensorApi);
    assert.equal(old.CODEX_HOME,c.instances[0].homeDir);
    assert.equal(sensor.CODEX_HOME,c.instances[1].homeDir);
    for(const env of [old,sensor]){
      assert.equal(env.OPENAI_API_KEY,undefined);
      assert.equal(env.GITLAB_API_TOKEN,undefined);
      assert.equal(env.GITLAB_WEBHOOK_SIGNING_TOKEN,undefined);
      assert.equal(env.CODEX_REVIEW_MULTI_CONFIG_FILE,undefined);
    }
    assert.notEqual(old.GITLAB_WEBHOOK_SIGNING_TOKEN_FILE,sensor.GITLAB_WEBHOOK_SIGNING_TOKEN_FILE);
  }finally{f.close();}
});
test('manifest fail-closes duplicate routing identities, endpoints and SQLite homes',()=>{
  for(const mutate of [
    f=>{f.manifest.instances[1].id='legacy';},
    f=>{f.manifest.server.defaultInstance='missing';},
    f=>{delete f.manifest.server.sharedProcessTrustAcknowledged;},
    f=>{f.manifest.server.sharedProcessTrustAcknowledged=false;},
    f=>{f.sensor.gitlab.baseUrl=f.legacy.gitlab.baseUrl;f.sensor.webhook.expectedInstance=f.sensor.gitlab.baseUrl;},
    f=>{f.sensor.server.dataDir=f.legacy.server.dataDir;},
    f=>{f.sensor.server.dataDir=path.join(f.legacy.server.dataDir,'nested');},
    f=>{f.manifest.instances[1].homeDir=f.manifest.instances[0].homeDir;},
    f=>{f.manifest.instances[1].configFile=f.manifest.instances[0].configFile;},
    f=>{f.sensor.webhook.expectedInstance='http://192.168.1.4';},
    f=>{f.sensor.gitlab.deprecatedCredential='inline-credential';},
    f=>{f.sensor.gitlab.projects=[0];},
    f=>{f.sensor.gitlab.projects=['113'];},
    f=>{f.sensor.gitlab.projects=[Number.MAX_SAFE_INTEGER+10];},
    f=>{f.sensor.gitlab.groups=[{id:0,includeSubgroups:true}];},
    f=>{f.sensor.gitlab.groups=[{id:48,includeSubgroups:'yes'}];},
    f=>{f.sensor.unsupportedSection={enabled:true};},
    f=>{f.manifest.server.port=65536;},
    f=>{f.manifest.instances[1].id='../sensor';}
  ]){
    const f=fixture();try{mutate(f);f.flush();assert.throws(()=>loadMultiManifest(f.manifestFile),/multi|instance|overlap|duplicate|shared|must|same|port|file|URL|credential|boundary|scope/i);}
    finally{f.close();}
  }
});
test('invalid or reused GitLab API and webhook secrets fail closed',()=>{
  for(const mutate of [
    f=>{f.manifest.instances[1].secretFiles.GITLAB_API_TOKEN_FILE=f.tokens.legacyApi;},
    f=>{fs.writeFileSync(f.tokens.sensorApi,'legacy-api-credential');},
    f=>{fs.writeFileSync(f.tokens.sensorWebhook,fs.readFileSync(f.tokens.legacyWebhook));},
    f=>{f.manifest.instances[1].secretFiles.GITLAB_API_TOKEN_FILE='relative-token';},
    f=>{delete f.manifest.instances[1].secretFiles.GITLAB_WEBHOOK_SIGNING_TOKEN_FILE;},
    f=>{f.manifest.instances[1].secretFiles.UNSAFE_INLINE_KEY='some-key';},
    f=>{fs.writeFileSync(f.tokens.sensorWebhook,'');}
  ]){
    const f=fixture();try{mutate(f);f.flush();assert.throws(()=>loadMultiManifest(f.manifestFile),/secret|file|credential|absolute|shared|invalid|empty|unsupported/i);}
    finally{f.close();}
  }
});
test('explicit multi manifest prevents silent single-instance configuration fallback',()=>{
  const f=fixture();try{
    delete f.manifest.schemaVersion;f.flush();
    assert.throws(()=>loadMultiManifest(f.manifestFile),/unsupported multi-instance manifest schema/);
    f.manifest.schemaVersion=1;
    f.sensor.schemaVersion=7;f.flush();
    assert.throws(()=>loadMultiManifest(f.manifestFile),/Config Schema 8/);
    f.sensor.schemaVersion=8;
    f.sensor.gitlab.projects=[];f.flush();
    assert.throws(()=>loadMultiManifest(f.manifestFile),/scope at least one/);
  }finally{f.close();}
});

(process.platform==='win32'?test.skip:test)('physical symlinks cannot alias tenant DB, Codex home or secret files',()=>{
  const cases=[
    f=>{
      fs.mkdirSync(f.legacy.server.dataDir);
      fs.symlinkSync(f.legacy.server.dataDir,f.location('sensor-db-alias'));
      f.sensor.server.dataDir=f.location('sensor-db-alias');
    },
    f=>{
      fs.mkdirSync(f.manifest.instances[0].homeDir);
      fs.symlinkSync(f.manifest.instances[0].homeDir,f.manifest.instances[1].homeDir);
    },
    f=>{
      const link=f.location('sensor-secret-link');
      fs.symlinkSync(f.tokens.sensorApi,link);
      f.manifest.instances[1].secretFiles.GITLAB_API_TOKEN_FILE=link;
    },
    f=>{
      fs.mkdirSync(f.legacy.server.dataDir);
      const token=path.join(f.legacy.server.dataDir,'sensor-api-secret');
      fs.writeFileSync(token,'sensor-api-alternate-value');
      f.manifest.instances[1].secretFiles.GITLAB_API_TOKEN_FILE=token;
    }
  ];
  for(const mutate of cases){
    const f=fixture();try{
      mutate(f);f.flush();
      assert.throws(()=>loadMultiManifest(f.manifestFile),
        /symlink|overlap|share|writable tenant|file must/i);
    }finally{f.close();}
  }
  const f=fixture();try{
    const link=f.location('manifest-link');
    fs.symlinkSync(f.manifestFile,link);
    assert.throws(()=>loadMultiManifest(link),/non-symlink file/);
  }finally{f.close();}
});
