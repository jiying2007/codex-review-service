'use strict';
// Invoked ONLY by a separate trusted CI/reviewer identity, never by PR tests.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {signedMessage,digest,readRegularBytes,verifyEnvelope,validateCi,validateTrust}=require('./offline-evidence');
function args(argv){const out={};for(let i=0;i<argv.length;i+=2){
 if(!argv[i]?.startsWith('--')||argv[i+1]===undefined||out[argv[i]])throw Error('Invalid signer flags');
 out[argv[i].slice(2)]=argv[i+1];
}return out;}
function safeSecret(file){
 if(!path.isAbsolute(file))throw Error('Private key must be outside checkout');
 const checkout=path.resolve(__dirname,'..');
 const relative=path.relative(checkout,file);
 if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))
   throw Error('Private signer key must not be stored inside the source checkout');
 const stat=fs.lstatSync(file);
 if(stat.isSymbolicLink()||!stat.isFile()||(stat.mode&0o077)!==0)
   throw Error('Private key must be a regular 0600 non-symlink file');
 const key=crypto.createPrivateKey(fs.readFileSync(file));
 if(key.asymmetricKeyType!=='ed25519')throw Error('Only Ed25519 private keys supported');
 return key;
}
function sign(payload,keyId,privateKeyFile){
 if(!/^[a-z][a-z0-9-]{0,63}$/.test(keyId))throw Error('Invalid signing key identifier');
 if(!payload||payload.schemaVersion!==1||!['ci','review'].includes(payload.kind))
   throw Error('Unsupported signed receipt kind');
 const unsigned={schemaVersion:1,keyId,payload};
 return{...unsigned,signature:crypto.sign(null,signedMessage(unsigned),safeSecret(privateKeyFile)).toString('base64')};
}
function signReview({ciFile,author,reviewer,sha,privateKeyFile,keyId}){
 if(!/^[a-z][a-z0-9-]{0,63}$/.test(reviewer)||reviewer===author||
   !/^[a-z][a-z0-9-]{0,63}$/.test(author)||!/^[0-9a-f]{40}$/.test(sha))
   throw Error('Independent reviewer, author and exact sha required');
 const ciBytes=fs.readFileSync(ciFile),ci=JSON.parse(ciBytes);
 if(ci?.payload?.kind!=='ci'||ci.payload.sha!==sha||ci.payload.author!==author)
   throw Error('Review must bind to exact signed CI receipt and author');
 const payload={schemaVersion:1,kind:'review',repository:'jiying2007/codex-review-service',
   sha,author,reviewer,decision:'approved',issuedAt:new Date().toISOString(),ciSha256:digest(ciBytes)};
 return sign(payload,keyId,privateKeyFile);
}
function main(){const a=args(process.argv.slice(2));
 if(!path.isAbsolute(a.output||'')||!path.isAbsolute(a.trust||'')||!path.isAbsolute(a.logs||''))
   throw Error('Absolute output, trust and log directory required');
 if(!['development','production','production-multi'].includes(a.mode))throw Error('Explicit mode required');
 const trust=validateTrust(JSON.parse(readRegularBytes(a.trust).toString('utf8')));
 const identity=a.type==='ci'?'ci':a.type==='review'?'review':null;
 if(!identity)throw Error('Must choose ci or review signer identity');
 if(a['key-id']!==trust[identity].keyId)throw Error('Signer key is not trusted');
 const authorized=crypto.createPublicKey(trust[identity].publicKeyPem).export({type:'spki',format:'der'});
 const actual=crypto.createPublicKey(safeSecret(a.key)).export({type:'spki',format:'der'});
 if(!actual.equals(authorized))throw Error('Private key does not match admin-trusted signing principal');
 let result;
 if(a.type==='ci'){
   const payload=JSON.parse(readRegularBytes(a.input).toString('utf8'));
   validateCi(payload,{sha:a.sha,author:a.author,mode:a.mode,trust,logsDir:a.logs,now:Date.now()});
   result=sign(payload,a['key-id'],a.key);
 }else{
   if(a.mode==='development')throw Error('Reviewer signing only applies to production');
   const envelope=JSON.parse(readRegularBytes(a.ci).toString('utf8'));
   const payload=verifyEnvelope(envelope,trust.ci.keyId,trust.ci.publicKeyPem);
   validateCi(payload,{sha:a.sha,author:a.author,mode:a.mode,trust,logsDir:a.logs,now:Date.now()});
   result=signReview({ciFile:a.ci,author:a.author,reviewer:a.reviewer,sha:a.sha,
     privateKeyFile:a.key,keyId:a['key-id']});
 }
 fs.writeFileSync(a.output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 process.stdout.write(JSON.stringify({ok:true,kind:result.payload.kind,sha:result.payload.sha})+'\n');
}
if(require.main===module){try{main();}catch(e){process.stderr.write(JSON.stringify({ok:false,code:e.code||'ESIGN'})+'\n');process.exitCode=2;}}
module.exports={sign,signReview,safeSecret};
