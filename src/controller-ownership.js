'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');

// Hold an OS-backed SQLite exclusive lock in a separate sidecar for the
// controller lifetime. SQLite releases it on process death; no PID expiry,
// lease timeout or unsafe stale-lock unlink is needed. Never delete this file.
function acquireControllerOwnership(dbPath){
  if(!dbPath||dbPath===':memory:')throw Object.assign(new Error('Controller ownership requires durable storage'),{code:'ECONTROLLERPATH'});
  const absolute=path.resolve(dbPath);
  fs.mkdirSync(path.dirname(absolute),{recursive:true,mode:0o700});
  const canonical=fs.existsSync(absolute)?fs.realpathSync(absolute):path.join(fs.realpathSync(path.dirname(absolute)),path.basename(absolute));
  const lockPath=`${canonical}.controller-lock.sqlite`;
  let lock;
  try{
    lock=new DatabaseSync(lockPath);
    lock.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
    fs.chmodSync(lockPath,0o600);
  }catch(cause){
    try{lock?.close();}catch{}
    throw Object.assign(new Error('Cannot acquire exclusive controller ownership of the state database'),{code:'ECONTROLLEROWNERSHIP',cause});
  }
  let released=false;
  return Object.freeze({dbPath:canonical,release(){if(released)return;released=true;try{lock.exec('ROLLBACK');}finally{lock.close();}}});
}

module.exports={acquireControllerOwnership};
