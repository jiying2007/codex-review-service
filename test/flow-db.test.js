'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const{DatabaseSync}=require('node:sqlite');
const{Store}=require('../src/db');

test('flow state increments revision only on real status transition',()=>{const store=new Store(':memory:');try{assert.equal(store.schemaVersion(),7);const a=store.transitionFlowState({projectId:1,flowType:'pipeline',externalId:'9',ref:'main',status:'running',deliveryIdentity:'a'});assert.deepEqual(a,{changed:true,previousStatus:'',revision:1});const duplicate=store.transitionFlowState({projectId:1,flowType:'pipeline',externalId:'9',ref:'main',status:'running',deliveryIdentity:'b'});assert.deepEqual(duplicate,{changed:false,previousStatus:'running',revision:1});const b=store.transitionFlowState({projectId:1,flowType:'pipeline',externalId:'9',ref:'main',status:'failed',deliveryIdentity:'c'});assert.deepEqual(b,{changed:true,previousStatus:'running',revision:2});const row=store.db.prepare('SELECT * FROM flow_state WHERE project_id=1 AND flow_type=\'pipeline\' AND external_id=\'9\'').get();assert.equal(row.previous_status,'running');assert.equal(row.current_status,'failed');assert.equal(row.revision,2);assert.equal(row.delivery_identity,'c');}finally{store.close();}});

test('schema 6 migrates durably to schema 7 with flow_state',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-flow-db-')),dbPath=path.join(dir,'service.sqlite');const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL,backup_path TEXT NOT NULL DEFAULT \'\'); PRAGMA user_version=6;');db.close();let store;try{store=new Store(dbPath);assert.equal(store.schemaVersion(),7);assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='flow_state'").get());const migration=store.db.prepare('SELECT * FROM schema_migrations WHERE version=7').get();assert.ok(migration.backup_path.endsWith('.bak'));assert.ok(fs.existsSync(migration.backup_path));}finally{store?.close();fs.rmSync(dir,{recursive:true,force:true});}});
