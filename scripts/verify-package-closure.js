'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-review-service-package-closure-'));
try{
  const raw=execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',tmp],{cwd:root,encoding:'utf8'}),artifact=path.join(tmp,JSON.parse(raw)[0].filename),unpack=path.join(tmp,'unpack');
  fs.mkdirSync(unpack);execFileSync('tar',['-xzf',artifact,'-C',unpack]);
  const packageRoot=path.join(unpack,'package'),entry=path.join(packageRoot,'src','codex-safe-core','index.js');
  if(!fs.existsSync(entry))throw new Error('Packaged Safe Core index is missing.');
  require(entry);
  for(const runtime of ['src/index.js','src/model-routing-runtime.js','src/review.js','src/notification.js'])if(!fs.existsSync(path.join(packageRoot,runtime)))throw new Error(`Packaged runtime entry is missing: ${runtime}`);
  for(const qualityAsset of ['src/differential-quality.js','quality/cross-review-corpus.json'])if(!fs.existsSync(path.join(packageRoot,qualityAsset)))throw new Error(`Packaged differential quality asset is missing: ${qualityAsset}`);
  const differential=require(path.join(packageRoot,'src','differential-quality.js'));
  if(Number(differential.DIFFERENTIAL_SCHEMA_VERSION)!==1)throw new Error('Packaged differential quality contract version is invalid.');
  const corpus=JSON.parse(fs.readFileSync(path.join(packageRoot,'quality','cross-review-corpus.json'),'utf8'));
  if(corpus.schemaVersion!==1||!Array.isArray(corpus.cases)||corpus.cases.length<6)throw new Error('Packaged cross-review corpus is incomplete.');
  console.log('Service package module and differential-quality closure verified.');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
