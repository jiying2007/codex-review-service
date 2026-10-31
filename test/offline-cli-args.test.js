'use strict';
// Purely local CLI contracts: no model, signing key or production trust root.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const SHA='a'.repeat(40);
const privateValue='argument-value-must-not-be-logged';
function childEnv(home){
  const env={HOME:home,LANG:'C',CI:'true',GIT_TERMINAL_PROMPT:'0'};
  for(const name of ['PATH','SystemRoot','SYSTEMROOT','WINDIR','TMPDIR','TMP','TEMP'])
    if(typeof process.env[name]==='string')env[name]=process.env[name];
  return env;
}
function run(script,argv,home){
  const result=spawnSync(process.execPath,[path.join(root,'scripts',script),...argv],{
    cwd:root,env:childEnv(home),encoding:'utf8',timeout:10000,maxBuffer:1024*1024,shell:false
  });
  assert.ifError(result.error);
  return result;
}
const malformed=[
  ['--sha',SHA,'--sha','b'.repeat(40)],
  ['--author','author','--author','author'],
  ['--sha','','--sha',SHA],
  ['--unexpected',privateValue],
  ['--sha',''],
  ['--sha'],
  ['--sha','--author'],
  ['--__proto__',privateValue]
];
for(const [script,prefix,code] of [
  ['collect-offline-ci.js',[],'EARGS'],
  ['sign-offline-evidence.js',[],'EARGS'],
  ['offline-evidence.js',['verify'],'EUSAGE']
])test(script+' refuses ambiguous CLI input before opening evidence or keys',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'offline-cli-args-'));
  try{
    for(const argv of malformed){
      const result=run(script,[...prefix,...argv],dir);
      assert.equal(result.status,2);
      assert.equal(result.stdout,'');
      assert.deepEqual(JSON.parse(result.stderr),{ok:false,code});
      assert.equal(result.stderr.includes(privateValue),false);
      assert.deepEqual(fs.readdirSync(dir),[],'argument rejection must not create output');
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'offline-cli-source-'));
  const source=path.join(dir,'source with spaces'),output=path.join(dir,'evidence with spaces');
  fs.mkdirSync(source);fs.mkdirSync(path.join(source,'scripts'));
  fs.writeFileSync(path.join(source,'scripts/check-syntax.js'),"console.log('local fixture executed');\n");
  const git=(...argv)=>{
    const result=spawnSync('git',['-C',source,...argv],{
      env:childEnv(dir),encoding:'utf8',timeout:10000,shell:false
    });
    assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
    return result.stdout.trim();
  };
  git('init');git('config','user.name','Offline fixture');
  git('config','user.email','offline@example.invalid');git('add','.');git('commit','-m','fixture');
  const sha=git('rev-parse','HEAD');
  const argv=['--checkout',source,'--output',output,'--sha',sha,
    '--author','author','--issuer','ci-agent','--runner','isolated-runner','--suites','syntax'];
  return{dir,source,output,sha,argv,close:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('collector rejects a conflicting earlier SHA instead of silently using the last value',()=>{
  const f=fixture();try{
    const result=run('collect-offline-ci.js',['--sha','f'.repeat(40),...f.argv],f.dir);
    assert.equal(result.status,2,'duplicate identity must not run the suite');
    assert.deepEqual(JSON.parse(result.stderr),{ok:false,code:'EARGS'});
    assert.equal(fs.existsSync(f.output),false,'no evidence directory or receipt may be created');
  }finally{f.close();}
});
test('unique collector arguments preserve paths containing spaces and produce real unsigned evidence',()=>{
  const f=fixture();try{
    const result=run('collect-offline-ci.js',f.argv,f.dir);
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).ok,true);
    const receipt=JSON.parse(fs.readFileSync(path.join(f.output,'ci.unsigned.json'),'utf8'));
    assert.equal(receipt.sha,f.sha);assert.equal(receipt.suites[0].exitCode,0);
    assert.match(fs.readFileSync(path.join(f.output,'logs/syntax.log'),'utf8'),/local fixture executed/);
  }finally{f.close();}
});
