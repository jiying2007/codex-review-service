'use strict';
// Real loopback Nginx/TLS fixture. Does not read operator credentials or hosts.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync,spawn}=require('node:child_process');
const http=require('node:http'),https=require('node:https'),net=require('node:net'),assert=require('node:assert/strict');
function command(name,args,cwd){return execFileSync(name,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000});}
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});}
function request(port,route,{method='GET',ca,cert,key,body=''}={}){return new Promise((resolve,reject)=>{
 const r=https.request({hostname:'127.0.0.1',port,path:route,method,servername:'localhost',ca,cert,key,rejectUnauthorized:true,
  headers:{'content-length':Buffer.byteLength(body),'x-gitlab-token':'local-fixture-only'}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));res.on('error',reject);
  });r.on('error',reject);r.setTimeout(2000,()=>r.destroy(new Error('fixture request timeout')));r.end(body);
});}
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-tls-fixture-'));fs.chmodSync(root,0o700);
 let backend,nginx;
 const results=[];
 try{
  command('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-days','1','-subj','/CN=FixtureCA','-keyout','ca.key','-out','ca.crt'],root);
  for(const name of ['server','client']){
   command('openssl',['req','-new','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-subj','/CN='+name,'-keyout',name+'.key','-out',name+'.csr'],root);
   fs.writeFileSync(path.join(root,name+'.ext'),'basicConstraints=CA:FALSE\nextendedKeyUsage='+ (name==='server'?'serverAuth\nsubjectAltName=DNS:localhost':'clientAuth')+'\n');
   command('openssl',['x509','-req','-in',name+'.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial','-days','1','-extfile',name+'.ext','-out',name+'.crt'],root);
  }
  command('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-days','1','-subj','/CN=WrongClient','-keyout','wrong.key','-out','wrong.crt'],root);
  const events=[];
  backend=http.createServer((req,res)=>{let body='';req.on('data',c=>{body+=c;});req.on('end',()=>{
    events.push({method:req.method,path:req.url,body,token:req.headers['x-gitlab-token']});
    res.writeHead(req.method==='POST'?202:200);res.end(req.url==='/metrics'?'fixture_metric 1\n':'ok');
  });});
  await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
  const publicPort=await freePort(),managementPort=await freePort();
  if(publicPort===managementPort)throw new Error('Fixture ports collided; retry the test');
  let template=fs.readFileSync(path.join(__dirname,'../deploy/nginx/fleet-ingress.conf.example'),'utf8');
  template=template.replace('127.0.0.1:8799','127.0.0.1:'+backend.address().port)
    .replace('listen 443 ssl;','listen 127.0.0.1:'+publicPort+' ssl;')
    .replace('127.0.0.1:9443','127.0.0.1:'+managementPort)
    .replaceAll('/etc/codex-review/tls/ingress.crt',root+'/server.crt').replaceAll('/etc/codex-review/tls/ingress.key',root+'/server.key')
    .replaceAll('/etc/codex-review/tls/management.crt',root+'/server.crt').replaceAll('/etc/codex-review/tls/management.key',root+'/server.key')
    .replaceAll('/etc/codex-review/tls/monitoring-ca.crt',root+'/ca.crt');
  const config=path.join(root,'nginx.conf');
  fs.writeFileSync(config,`daemon off; master_process off; pid ${root}/nginx.pid; error_log ${root}/error.log;\nevents {}\nhttp { access_log off; client_body_temp_path ${root}/body; proxy_temp_path ${root}/proxy;\n${template}\n}\n`);
  command('nginx',['-t','-p',root+'/', '-c',config],root);
  nginx=spawn('nginx',['-p',root+'/', '-c',config],{stdio:'ignore'});
  const ca=fs.readFileSync(path.join(root,'ca.crt')),cert=fs.readFileSync(path.join(root,'client.crt')),key=fs.readFileSync(path.join(root,'client.key'));
  let ready=false;
  for(let n=0;n<30;n++){try{await request(publicPort,'/',{ca});ready=true;break;}catch{await new Promise(r=>setTimeout(r,50));}}
  if(!ready)throw new Error('Local nginx did not start');
  for(const route of ['/metrics','/repositories','/repositories/status','/instances/primary/metrics','/webhooks/gitlab']){
    assert.equal((await request(publicPort,route,{ca})).status,404);results.push('public-denied:'+route);
  }
  assert.equal((await request(publicPort,'/webhooks/gitlab/primary',{ca})).status,405);results.push('webhook-method');
  const body='{"fixture":true}';
  assert.equal((await request(publicPort,'/webhooks/gitlab/primary',{ca,method:'POST',body})).status,202);
  assert.deepEqual(events.at(-1),{method:'POST',path:'/webhooks/gitlab/primary',body,token:'local-fixture-only'});results.push('webhook-raw-delivery');
  for(const identity of [{},{cert:fs.readFileSync(path.join(root,'wrong.crt')),key:fs.readFileSync(path.join(root,'wrong.key'))}]){
    const count=events.length;
    try {const denied=await request(managementPort,'/metrics',{ca,...identity});assert.equal(denied.status,400);}
    catch(error){if(!['ECONNRESET','ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED','ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE','ERR_SSL_TLSV1_ALERT_UNKNOWN_CA'].includes(error.code))throw error;}
    assert.equal(events.length,count);results.push('management-rejected-client');
  }
  assert.equal((await request(managementPort,'/metrics',{ca,cert,key})).body,'fixture_metric 1\n');results.push('management-valid-client');
  assert.equal((await request(managementPort,'/metrics',{ca,cert,key,method:'POST'})).status,405);results.push('management-read-only');
  assert.equal((await request(managementPort,'/webhooks/gitlab/primary',{ca,cert,key,method:'POST'})).status,404);results.push('management-no-webhook');
  const receipt={schemaVersion:1,kind:'local_nginx_tls_ingress_fixture',sourceSha:process.env.GITHUB_SHA||null,node:process.version,
    checks:results,passed:results.length,productionQualified:false,modelCalls:0,remoteHostsContacted:0};
  process.stdout.write(JSON.stringify(receipt,null,2)+'\n');
  if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  return receipt;
 }finally{
  if(nginx&&nginx.exitCode===null){nginx.kill('SIGTERM');await new Promise(resolve=>nginx.once('close',resolve));}
  if(backend){backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));}
  fs.rmSync(root,{recursive:true,force:true});
 }
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
