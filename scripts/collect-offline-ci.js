'use strict';
// Run explicit no-Codex suites on an isolated worker, recording actual exit
// codes and hashes. This artifact is UNSIGNED; an independent CI signer and
// release authority must separately verify and attest it.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const REPO='jiying2007/codex-review-service';
const SUITES=Object.freeze({
  syntax:['scripts/check-syntax.js'],
  'offline-unit':['--test','test/db-migrations.test.js','test/db.test.js','test/http.test.js',
    'test/webhook.test.js','test/assignment-policy.test.js','test/project-scope.test.js'],
  migration:['--test','test/db-migrations.test.js','test/db.test.js'],
  'multi-offline':['--test','test/multi-gitlab-admin.test.js','test/multi-gitlab-config.test.js',
    'test/multi-gitlab-cutover.test.js','test/multi-gitlab-deployment.test.js',
    'test/multi-gitlab-gateway.test.js','test/multi-gitlab-preflight.test.js',
    'test/multi-gitlab-real-worker-env.test.js','test/multi-gitlab-runtime.test.js']
});
function noSecrets(parent=process.env){
  const result={};
  for(const key of ['PATH','HOME','LANG','LC_ALL','TMPDIR','TEMP','TMP','SystemRoot','WINDIR','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE'])
    if(typeof parent[key]==='string')result[key]=parent[key];
  result.CI='true';result.NO_COLOR='1';result.GIT_TERMINAL_PROMPT='0';result.CODEX_OFFLINE_EVIDENCE='1';
  return result;
}
function sha256(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}
function argMap(argv){const o={};for(let i=0;i<argv.length;i+=2){
  if(!argv[i]?.startsWith('--')||argv[i+1]===undefined||o[argv[i]])throw Error('Invalid CLI flags');
  o[argv[i].slice(2)]=argv[i+1];
}return o;}
function collect({repoDir,outDir,sha,author,issuer,runner,suiteIds,spawn=spawnSync,now=Date.now()}){
  if(!path.isAbsolute(repoDir)||!path.isAbsolute(outDir)||outDir===repoDir||
    outDir.startsWith(repoDir+path.sep))throw Error('Outputs must be outside the checkout');
  if(!/^[0-9a-f]{40}$/.test(sha)||![author,issuer,runner].every(x=>/^[a-z][a-z0-9-]{0,63}$/.test(x)))
    throw Error('Exact git commit and bounded operator identities required');
  if(!Array.isArray(suiteIds)||!suiteIds.length||suiteIds.some(x=>!Object.hasOwn(SUITES,x))||
     new Set(suiteIds).size!==suiteIds.length)throw Error('Only unique hardcoded offline suites are permitted');
  // Never replace an older receipt or permit a symlink to move evidence into
  // a checkout, a signing-key directory or another operator's workspace.
  const repoReal=fs.realpathSync(repoDir);
  if(fs.existsSync(outDir)){
    const stat=fs.lstatSync(outDir);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Evidence output must be a real directory');
  }else fs.mkdirSync(outDir,{mode:0o700});
  const evidenceReal=fs.realpathSync(outDir);
  if(evidenceReal===repoReal||evidenceReal.startsWith(repoReal+path.sep))
    throw Error('Physical evidence output must be outside the checkout');
  if(fs.readdirSync(outDir).length!==0||
    (process.platform!=='win32'&&(fs.statSync(outDir).mode&0o077)!==0))
    throw Error('Evidence output must be fresh, empty and private');
  const git=(...args)=>{const r=spawn('git',['-C',repoDir,...args],{
    encoding:'utf8',timeout:20000,env:noSecrets(),shell:false});
    if(r.error||r.status!==0)throw Error('Git checkout integrity check failed');
    return r.stdout.trim();
  };
  if(git('rev-parse','HEAD')!==sha)throw Error('Requested SHA is not checked out');
  if(git('status','--porcelain','--untracked-files=all'))throw Error('Evidence cannot be collected from a dirty checkout');
  const submodules=git('submodule','status','--recursive');
  if(submodules.split('\n').some(line=>line && /^[-+U]/.test(line)))
    throw Error('Evidence cannot be collected from an uninitialized or changed submodule');
  const logsDir=path.join(outDir,'logs');fs.mkdirSync(logsDir,{mode:0o700});
  const workerHome=path.join(outDir,'worker-home');fs.mkdirSync(workerHome,{mode:0o700});
  const runnerEnv={...noSecrets(),HOME:workerHome};
  const results=[];
  for(const id of suiteIds){
    const started=Date.now();
    const r=spawn(process.execPath,SUITES[id],{cwd:repoDir,encoding:'utf8',
      timeout:300000,maxBuffer:16*1024*1024,shell:false,env:runnerEnv});
    const exitCode=Number.isInteger(r.status)?r.status:124;
    const durationMs=Math.max(0,Date.now()-started);
    const log=Buffer.from('suite='+id+'\nexitCode='+exitCode+'\n'+
      (r.error?'errorCode='+String(r.error.code||'EEXEC')+'\n':'')+
      String(r.stdout||'')+'\n'+String(r.stderr||''));
    const file=path.join(logsDir,id+'.log');fs.writeFileSync(file,log,{flag:'wx',mode:0o600});
    results.push({id,exitCode,durationMs,logSha256:sha256(log)});
  }
  const payload={schemaVersion:1,kind:'ci',repository:REPO,sha,author,issuer,runner,
    issuedAt:new Date(now).toISOString(),suites:results};
  fs.writeFileSync(path.join(outDir,'ci.unsigned.json'),JSON.stringify(payload,null,2)+'\n',{flag:'wx',mode:0o600});
  return{ok:results.every(s=>s.exitCode===0),receipt:'ci.unsigned.json',results};
}
function main(){const a=argMap(process.argv.slice(2));
  const result=collect({repoDir:a.checkout,outDir:a.output,sha:a.sha,author:a.author,
    issuer:a.issuer,runner:a.runner,suiteIds:String(a.suites||'').split(',')});
  process.stdout.write(JSON.stringify(result)+'\n');if(!result.ok)process.exitCode=2;
}
if(require.main===module){try{main();}catch(e){process.stderr.write(JSON.stringify({ok:false,code:e.code||'ECOLLECT'})+'\n');process.exitCode=2;}}
module.exports={collect,noSecrets,SUITES};
