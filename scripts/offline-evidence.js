'use strict';
// A portable, OFFLINE evidence validator. A signed receipt is an attestation
// by an independently entrusted actor, not proof of a GitHub Ruleset.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const REPOSITORY='jiying2007/codex-review-service';
const SHA=/^[0-9a-f]{40}$/;
const HEX=/^[0-9a-f]{64}$/;
const ID=/^[a-z][a-z0-9-]{0,63}$/;
const PRODUCTION_TRUST='/etc/codex-review/release-trust.json';
const REQUIRED=Object.freeze({
  development:['syntax','offline-unit'],
  production:['syntax','offline-unit','security','migration','provider','image'],
  'production-multi':['syntax','offline-unit','multi-offline','security','migration','provider','image']
});
function reject(code,message){const e=new Error(message);e.code=code;throw e;}
function readRegularBytes(filename){
  const flags=fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0);
  let fd;
  try{fd=fs.openSync(filename,flags);}
  catch(error){if(error.code==='ELOOP')reject('EFILE','Invalid or symlinked evidence file');throw error;}
  try{
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size>1024*1024)reject('EFILE','Invalid or symlinked evidence file');
    return fs.readFileSync(fd);
  }finally{fs.closeSync(fd);}
}
function fileJSON(filename){return JSON.parse(readRegularBytes(filename).toString('utf8'));}
function digest(buf){return crypto.createHash('sha256').update(buf).digest('hex');}
function keys(obj,allowed,label){
  if(!obj||typeof obj!=='object'||Array.isArray(obj))reject('ESCHEMA',label+' must be an object');
  for(const k of Object.keys(obj))if(!allowed.includes(k))reject('ESCHEMA',label+' has unknown field');
}
function isTimestamp(t,now,maxAgeHours){
  const ms=Date.parse(t);
  return typeof t==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(t)&&
    Number.isFinite(ms)&&ms<=now+5*60*1000&&ms>=now-maxAgeHours*3600*1000;
}
function exactBase(payload,kind){
  const specific=kind==='ci'?['issuer','runner','issuedAt','suites']:
    ['reviewer','decision','issuedAt','ciSha256'];
  keys(payload,['schemaVersion','kind','repository','sha','author',...specific],kind+' payload');
  if(payload.schemaVersion!==1||payload.kind!==kind||payload.repository!==REPOSITORY||
      typeof payload.sha!=='string'||!SHA.test(payload.sha))reject('ESCHEMA','Evidence identity is invalid');
  if(typeof payload.author!=='string'||!ID.test(payload.author))reject('ESCHEMA','Missing immutable author identity');
}
function signedMessage(envelope){
  return Buffer.from(JSON.stringify({schemaVersion:envelope.schemaVersion,
    keyId:envelope.keyId,payload:envelope.payload}),'utf8');
}
function verifyEnvelope(envelope,expectedKeyId,pem){
  keys(envelope,['schemaVersion','keyId','payload','signature'],'signed envelope');
  if(envelope.schemaVersion!==1||envelope.keyId!==expectedKeyId||
      typeof envelope.signature!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature))
    reject('ESIGNATURE','Missing/unknown signature or signer');
  const pub=crypto.createPublicKey(pem);
  if(pub.asymmetricKeyType!=='ed25519')reject('ESIGNATURE','Only Ed25519 keys are admissible');
  const sig=Buffer.from(envelope.signature,'base64');
  if(sig.length!==64||!crypto.verify(null,signedMessage(envelope),pub,sig))
    reject('ESIGNATURE','Evidence signature is invalid');
  return envelope.payload;
}
function validateTrust(trust){
  keys(trust,['schemaVersion','repository','ci','review','maxAgeHours'],'trust root');
  if(trust.schemaVersion!==1||trust.repository!==REPOSITORY)reject('ETRUST','Trust repository mismatch');
  for(const kind of ['ci','review']){
    keys(trust[kind],kind==='ci'?['keyId','publicKeyPem','allowedIdentities','allowedRunners']:
      ['keyId','publicKeyPem','allowedIdentities'],kind+' trust');
    if(!ID.test(trust[kind].keyId)||typeof trust[kind].publicKeyPem!=='string'||
      !Array.isArray(trust[kind].allowedIdentities)||!trust[kind].allowedIdentities.length||
      trust[kind].allowedIdentities.some(id=>typeof id!=='string'||!ID.test(id)))
      reject('ETRUST','Trusted signer identity is invalid');
  }
  if(!Array.isArray(trust.ci.allowedRunners)||!trust.ci.allowedRunners.length||
      trust.ci.allowedRunners.some(x=>typeof x!=='string'||!ID.test(x))||
      trust.ci.allowedIdentities.some(x=>trust.review.allowedIdentities.includes(x)))
    reject('ETRUST','CI runners and reviewer identities must be separately trusted');
  const ciKey=crypto.createPublicKey(trust.ci.publicKeyPem);
  const reviewerKey=crypto.createPublicKey(trust.review.publicKeyPem);
  if(ciKey.asymmetricKeyType!=='ed25519'||reviewerKey.asymmetricKeyType!=='ed25519'||
    ciKey.export({type:'spki',format:'der'}).equals(reviewerKey.export({type:'spki',format:'der'}))||
    trust.ci.keyId===trust.review.keyId)
    reject('ETRUST','CI and reviewer must use independent signing keys');
  if(!Number.isInteger(trust.maxAgeHours)||trust.maxAgeHours<1||trust.maxAgeHours>168)
    reject('ETRUST','Maximum receipt age must be 1-168 hours');
  return trust;
}
function validateCi(payload,{sha,author,mode,trust,logsDir,now}){
  exactBase(payload,'ci');
  if(payload.sha!==sha||payload.author!==author||
    !trust.ci.allowedIdentities.includes(payload.issuer)||payload.issuer===author||
    typeof payload.runner!=='string'||!trust.ci.allowedRunners.includes(payload.runner)||
    !isTimestamp(payload.issuedAt,now,trust.maxAgeHours))reject('EIDENTITY','CI identity/commit/age mismatch');
  if(!Array.isArray(payload.suites)||payload.suites.length<1||payload.suites.length>20)
    reject('ESUITE','CI suite collection is invalid');
  const seen=new Set();
  for(const suite of payload.suites){
    keys(suite,['id','exitCode','durationMs','logSha256'],'CI suite');
    if(typeof suite.id!=='string'||!ID.test(suite.id)||seen.has(suite.id)||
      suite.exitCode!==0||!Number.isSafeInteger(suite.durationMs)||suite.durationMs<0||
      typeof suite.logSha256!=='string'||!HEX.test(suite.logSha256))
      reject('ESUITE','Failed, repeated or malformed CI suite');
    seen.add(suite.id);
    const log=path.join(logsDir,suite.id+'.log');
    const stat=fs.lstatSync(log);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size===0||stat.size>16*1024*1024)
      reject('ELOG','Log must be present, regular and bounded');
    if(digest(fs.readFileSync(log))!==suite.logSha256)
      reject('ELOG','Raw test log digest mismatch');
  }
  for(const id of REQUIRED[mode])if(!seen.has(id))reject('ESUITE','Required suite missing: '+id);
}
function validateReview(payload,{sha,author,ciIssuer,trust,ciFileBytes,ciTime,now}){
  exactBase(payload,'review');
  if(payload.sha!==sha||payload.author!==author||
      typeof payload.reviewer!=='string'||!trust.review.allowedIdentities.includes(payload.reviewer)||
      payload.reviewer===author||payload.reviewer===ciIssuer||payload.decision!=='approved'||
      typeof payload.ciSha256!=='string'||payload.ciSha256!==digest(ciFileBytes)||
      !isTimestamp(payload.issuedAt,now,trust.maxAgeHours)||
      Date.parse(payload.issuedAt)<Date.parse(ciTime))
    reject('EREVIEW','Independent latest-head review or CI binding is invalid');
}
function verifyEvidence({trustFile,ciFile,reviewFile,logsDir,sha,author,mode='production',now=Date.now()}){
  if(!Object.hasOwn(REQUIRED,mode)||!SHA.test(sha||'')||!ID.test(author||''))
    reject('EINPUT','An exact sha, PR author and recognized mode are required');
  for(const [label,file] of Object.entries({trustFile,ciFile,logsDir}))
    if(typeof file!=='string'||!path.isAbsolute(file))reject('EINPUT',label+' requires an absolute path');
  const trustStat=fs.lstatSync(trustFile);
  if(trustStat.isSymbolicLink()||!trustStat.isFile()||(trustStat.mode&0o022)!==0)
    reject('ETRUST','Trust root must be a regular file not writable by group/other');
  // For production admission the trust file must be administered outside the
  // source checkout; a self-submitted PR key is never sufficient.
  const trust=validateTrust(fileJSON(trustFile));
  const ciFileBytes=readRegularBytes(ciFile);
  const ci=verifyEnvelope(JSON.parse(ciFileBytes.toString('utf8')),trust.ci.keyId,trust.ci.publicKeyPem);
  validateCi(ci,{sha,author,mode,trust,logsDir,now});
  if(mode!=='development'){
    if(typeof reviewFile!=='string'||!path.isAbsolute(reviewFile))
      reject('EREVIEW','Production requires an independent review file');
    const reviewed=verifyEnvelope(fileJSON(reviewFile),trust.review.keyId,trust.review.publicKeyPem);
    validateReview(reviewed,{sha,author,ciIssuer:ci.issuer,trust,ciFileBytes,ciTime:ci.issuedAt,now});
  }
  return{ok:true,mode,repository:REPOSITORY,sha,suites:ci.suites.map(s=>s.id),
    independentlyReviewed:mode!=='development',ciEnvelopeSha256:digest(ciFileBytes)};
}
function main(args=process.argv.slice(2)){
  if(args[0]!=='verify')reject('EUSAGE','Usage: verify --trust ABS --ci ABS --logs ABS --sha SHA --author ID --mode development|production|production-multi [--review ABS]');
  const kv={};
  for(let i=1;i<args.length;i+=2){
    if(!args[i]?.startsWith('--')||args[i+1]===undefined||kv[args[i]])reject('EUSAGE','Malformed arguments');
    kv[args[i]]=args[i+1];
  }
  for(const k of Object.keys(kv))if(!['--trust','--ci','--review','--logs','--sha','--author','--mode'].includes(k))reject('EUSAGE','Unknown flag');
  if(kv['--mode']!=='development'){
    if(kv['--trust']!==PRODUCTION_TRUST)reject('ETRUSTPATH','Production trust root is fixed outside the checkout');
    if(process.platform!=='win32'&&fs.lstatSync(PRODUCTION_TRUST).uid!==0)
      reject('ETRUSTOWNER','Production trust root must be root-owned');
  }
  return verifyEvidence({trustFile:kv['--trust'],ciFile:kv['--ci'],reviewFile:kv['--review'],
    logsDir:kv['--logs'],sha:kv['--sha'],author:kv['--author'],mode:kv['--mode']});
}
if(require.main===module){
  try{process.stdout.write(JSON.stringify(main())+'\n');}
  catch(e){process.stderr.write(JSON.stringify({ok:false,code:e.code||'EADMISSION'})+'\n');process.exitCode=2;}
}
module.exports={REPOSITORY,PRODUCTION_TRUST,REQUIRED,readRegularBytes,digest,signedMessage,verifyEnvelope,validateTrust,validateCi,verifyEvidence,main};
