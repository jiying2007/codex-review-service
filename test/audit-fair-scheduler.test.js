'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { installFairScheduling } = require('../src/fair-scheduler');
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE review_jobs(id INTEGER PRIMARY KEY,project_id INTEGER,mr_iid INTEGER,status TEXT,
    available_at TEXT,started_at TEXT,attempt INTEGER DEFAULT 0);
    CREATE INDEX queue_status ON review_jobs(status,available_at,id);
    CREATE INDEX queue_mr ON review_jobs(project_id,mr_iid,id);`);
  let historyReads = 0, callbacks = [];
  const store = {
    db: {prepare(sql) {
      const stmt = db.prepare(sql);
      if (sql.includes('SELECT MAX(started_at)')) return {get(id) {historyReads++;return stmt.get(id);}};
      return stmt;
    }},
    withTransaction(fn) {
      db.exec('BEGIN IMMEDIATE'); callbacks = [];
      let result;
      try {result = fn(); db.exec('COMMIT');} catch (error) {db.exec('ROLLBACK');callbacks=[];throw error;}
      const committed = callbacks; callbacks=[]; committed.forEach(fn => fn());return result;
    },
    afterCommit(fn) {callbacks.push(fn);},
    getJob(id) {return db.prepare('SELECT * FROM review_jobs WHERE id=?').get(id);}
  };
  return {db,store,historyReads:()=>historyReads,add(pid,mr,state='queued',start=null) {
    db.prepare('INSERT INTO review_jobs(project_id,mr_iid,status,available_at,started_at) VALUES(?,?,?,\'\',?)').run(pid,mr,state,start);
  }};
}
test('large hot-project backlog cannot monopolize claims; history is scanned once per project', t => {
  const x=fixture(t);
  for(let i=0;i<2000;i++)x.add(1,i+1);
  for(let i=0;i<20;i++)x.add(2,i+1);
  for(let i=0;i<20;i++)x.add(3,i+1);
  installFairScheduling(x.store);
  const seen=[];
  for(let i=0;i<30;i++) {
    const job=x.store.claimNext();seen.push(job.project_id);
    x.db.prepare("UPDATE review_jobs SET status='pass' WHERE id=?").run(job.id);
  }
  assert.deepEqual(seen,Array.from({length:30},(_,i)=>i%3+1));
  assert.equal(x.historyReads(),3,'historical MAX must not repeat per claim');
});
test('running MR fence, unavailable jobs and restart ordering remain authoritative', t => {
  const x=fixture(t);
  x.add(1,1,'pass','2026-01-01T01:00:00.000Z');x.add(1,2);
  x.add(2,1);x.add(3,1,'running','2026-01-01T00:00:00.000Z');x.add(3,1);
  x.add(4,1);x.db.exec("UPDATE review_jobs SET available_at='2999-01-01T00:00:00Z' WHERE project_id=4");
  installFairScheduling(x.store);
  assert.equal(x.store.claimNext().project_id,2);
  assert.equal(x.store.claimNext().project_id,1);
  assert.equal(x.store.claimNext(),null);
});
test('failed durable transaction does not advance process-local fairness', t => {
  const x=fixture(t);x.add(1,1);x.add(2,1);
  const scheduler=installFairScheduling(x.store),get=x.store.getJob;
  x.store.getJob=()=>{throw new Error('fixture read failure');};
  assert.throws(()=>x.store.claimNext(),/fixture/);
  assert.deepEqual(scheduler.snapshot(),{});
  assert.equal(x.db.prepare("SELECT COUNT(*) n FROM review_jobs WHERE status='running'").get().n,0);
  x.store.getJob=get;
  assert.equal(x.store.claimNext().project_id,1);
});
