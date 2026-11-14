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
  // Fixture permissions must not depend on the caller's process umask.
  function write(name,content){const file=location(name);fs.writeFileSync(file,content,{mode:0o600});return file;}
  const tokens={
    legacyApi:write('legacy-api','legacy-api-credential'),
    legacyWebhook:write('legacy-hook','whsec_'+Buffer.alloc(32,3).toString('base64')),
    sensorApi:write('sensor-api','sensor-api-credential'),
    sensorWebhook:write('sensor-hook','whsec_'+Buffer.alloc(32,4).toString('base64'))
  };
  // Use the complete deployed Config Schema 8 reference. The production
  // loader requires every top-level section, even when its fields are defaulted.
  const template=JSON.parse(fs.readFileSync(path.join(__dirname,'../deploy/docker/config.example.json'),'utf8'));
  const makeConfig=(id,host,projects)=>{
    const cfg=structuredClone(template);
    cfg.server.host='127.0.0.1';
    cfg.server.dataDir=location(id+'-db');
    cfg.gitlab.baseUrl=host;
    cfg.gitlab.projects=projects;
    cfg.gitlab.groups=[];
    cfg.webhook.expectedInstance=host;
    cfg.review.triggerAssignment={mode:id==='sensor'?'always':'assignee',userIds:id==='sensor'?[]:[8]};
    cfg.codex.home=location(id+'-home');
    return cfg;
  };
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
    fs.writeFileSync(manifest.instances[0].configFile,JSON.stringify(legacy),{mode:0o600});
    fs.writeFileSync(manifest.instances[1].configFile,JSON.stringify(sensor),{mode:0o600});
    fs.writeFileSync(manifestFile,JSON.stringify(manifest),{mode:0o600});
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


test('optional Schema 8 sections may be omitted without weakening mandatory tenant isolation',()=>{
  const f=fixture();try{
    for(const optional of ['review','flowTracking','codex','runner','publication',
      'notifications','lifecycle','observability'])delete f.sensor[optional];
    f.flush();
    const result=loadMultiManifest(f.manifestFile);
    assert.equal(result.instances[0].origin,'http://192.168.1.4');
    assert.equal(result.instances[1].origin,'http://192.168.2.50');
    assert.notEqual(result.instances[0].dataDir,result.instances[1].dataDir);
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
    f=>{f.sensor.gitlab.groups=[{id:Number.MAX_SAFE_INTEGER+10,includeSubgroups:true}];},
    f=>{f.sensor.gitlab.groups=[{id:0,includeSubgroups:true}];},
    f=>{f.sensor.gitlab.groups=[{id:48,includeSubgroups:'yes'}];},
    f=>{f.sensor.unsupportedSection={enabled:true};},
    f=>{f.manifest.server.port=65536;},
    f=>{f.manifest.instances[1].id='../sensor';}
  ]){
    const f=fixture();try{mutate(f);f.flush();assert.throws(()=>loadMultiManifest(f.manifestFile),/multi|instance|overlap|duplicate|shared|must|same|port|file|URL|credential|boundary|scope|schema|invalid/i);}
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
    f=>{fs.writeFileSync(f.tokens.sensorWebhook,'');},
    f=>{fs.writeFileSync(f.tokens.sensorWebhook,'whsec_bad');},
    f=>{fs.writeFileSync(f.tokens.sensorWebhook,'whsec_'+Buffer.alloc(16,9).toString('base64'));},
    f=>{fs.writeFileSync(f.tokens.sensorWebhook,'whsec_'+Buffer.alloc(32,9).toString('base64').replace(/C/g,'!'));}
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
      fs.writeFileSync(token,'sensor-api-alternate-value',{mode:0o600});
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
    // Prove this fixture loads before changing only the manifest path.
    assert.equal(loadMultiManifest(f.manifestFile).instances.length,2);
    const link=f.location('manifest-link');
    fs.symlinkSync(f.manifestFile,link);
    assert.throws(()=>loadMultiManifest(link),error=>error.code==='EMULTIGITLABCONFIG');
  }finally{f.close();}
});

(process.platform==='win32'?test.skip:test)('hardened multi-GitLab configuration files reject group/world writable control inputs',()=>{
  for(const target of ['manifest','legacy-config','sensor-config','sensor-secret']){
    const f=fixture();
    try{
      const file=target==='manifest'?f.manifestFile:
        target==='legacy-config'?f.manifest.instances[0].configFile:
        target==='sensor-config'?f.manifest.instances[1].configFile:f.tokens.sensorApi;
      fs.chmodSync(file,0o666);
      assert.throws(()=>loadMultiManifest(f.manifestFile),/private|regular|file/i);
    }finally{f.close();}
  }
});
(process.platform==='win32'?test.skip:test)('hardlinked manifest, tenant config and credentials are not separate trust domains',()=>{
  for(const target of ['manifest','sensor-config','sensor-secret']){
    const f=fixture();
    try{
      if(target==='manifest'){
        const linked=f.location('linked-manifest.json');
        fs.linkSync(f.manifestFile,linked);
        assert.throws(()=>loadMultiManifest(linked),/private|regular/i);
      }else if(target==='sensor-config'){
        const linked=f.location('linked-sensor.json');
        fs.linkSync(f.manifest.instances[1].configFile,linked);
        f.manifest.instances[1].configFile=linked;
        f.flush();
        assert.throws(()=>loadMultiManifest(f.manifestFile),/private|regular/i);
      }else{
        const linked=f.location('linked-sensor-token');
        fs.linkSync(f.tokens.sensorApi,linked);
        f.manifest.instances[1].secretFiles.GITLAB_API_TOKEN_FILE=linked;
        f.flush();
        assert.throws(()=>loadMultiManifest(f.manifestFile),/private|regular/i);
      }
    }finally{f.close();}
  }
});
test('oversized manifest is rejected before parsing even if trailing JSON whitespace is valid',()=>{
  const f=fixture();try{
    fs.appendFileSync(f.manifestFile,' '.repeat(1024*1024));
    assert.throws(()=>loadMultiManifest(f.manifestFile),/private|regular|invalid/i);
  }finally{f.close();}
});

test('multi-GitLab admission rejects invalid UTF-8 instead of parsing replacement characters',()=>{
  for(const target of ['manifest','tenant']){
    const f=fixture();try{
      const file=target==='manifest'?f.manifestFile:f.manifest.instances[0].configFile;
      if(target==='manifest')f.manifest.server.host='utf8-probe';
      else f.legacy.codex.path='utf8-probe';
      f.flush();
      const bytes=fs.readFileSync(file),index=bytes.indexOf('utf8-probe');
      assert.ok(index>=0);
      // A valid replacement character is otherwise admissible. Only the raw
      // invalid UTF-8 byte must trigger this rejection, not another schema rule.
      fs.writeFileSync(file,bytes.toString('utf8').replace('utf8-probe','utf8-\uFFFDrobe'));
      assert.equal(loadMultiManifest(f.manifestFile).instances.length,2);
      bytes[index+5]=0xff;
      fs.writeFileSync(file,bytes);
      assert.throws(()=>loadMultiManifest(f.manifestFile),{code:'EMULTIGITLABCONFIG'});
    }finally{f.close();}
  }
});

test('strict tenant schema validation uses the checked object without reopening the config path',t=>{
  const f=fixture();try{
    const configPaths=new Set(f.manifest.instances.map(item=>item.configFile));
    const originalRead=fs.readFileSync;
    t.mock.method(fs,'readFileSync',(file,...args)=>{
      assert.equal(configPaths.has(file),false,'tenant validation reopened an admitted path');
      return originalRead(file,...args);
    });
    assert.equal(loadMultiManifest(f.manifestFile).instances.length,2);
    f.legacy.gitlab.unsupported='must still be rejected';f.flush();
    assert.throws(()=>loadMultiManifest(f.manifestFile),/invalid standalone Config Schema/);
  }finally{f.close();}
});

(process.platform==='win32'?test.skip:test)('control-file fixture permissions do not depend on the invoking shell umask',()=>{
  const {spawnSync}=require('node:child_process');
  // umask is process-global. Keep each case in its own bounded child instead
  // of mutating the test runner's mask or the source-controlled permission gate.
  const childScript=`
    'use strict';
    const fs=require('node:fs');
    const os=require('node:os');
    const path=require('node:path');
    const assert=require('node:assert/strict');
    const __dirname=process.argv[1];
    process.umask(Number(process.argv[2]));
    ${fixture.toString()}
    const f=fixture();
    try{
      const files=[f.manifestFile,...f.manifest.instances.map(item=>item.configFile),
        ...Object.values(f.tokens)];
      for(const file of files){
        const stat=fs.lstatSync(file);
        assert.equal(stat.isFile(),true);
        assert.equal(stat.nlink,1);
        assert.equal(stat.mode&0o777,0o600);
      }
    }finally{f.close();}
  `;
  for(const mask of [0o000,0o002,0o022,0o077]){
    const result=spawnSync(process.execPath,['-e',childScript,__dirname,String(mask)],{
      encoding:'utf8',timeout:10000,maxBuffer:1024*1024,shell:false,
      env:{PATH:process.env.PATH||'',TMPDIR:os.tmpdir(),HOME:os.tmpdir()}
    });
    assert.ifError(result.error);
    assert.equal(result.status,0,'fixture failed under umask '+mask.toString(8)+': '+result.stderr);
  }
});
