'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { ageSeconds, oldestAgeSeconds } = require('../src/metrics-age');
const { renderRepositoryMetrics, repositoryCounts } = require('../src/repository-metrics');
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE review_jobs(id INTEGER PRIMARY KEY,project_id INTEGER,mr_iid INTEGER,status TEXT,created_at TEXT);
    CREATE INDEX idx_review_jobs_mr ON review_jobs(project_id,mr_iid,id);
    CREATE INDEX idx_review_jobs_status_available ON review_jobs(status,id);
    CREATE TABLE model_calls(job_id INTEGER,usage_known INTEGER,input_tokens INTEGER,output_tokens INTEGER,started_at TEXT);`);
  return { db };
}
test('empty SQL aggregate is zero; unavailable or corrupt evidence fails closed', t => {
  const store = fixture(t);
  assert.equal(ageSeconds(store, 'review_jobs', ['queued']), 0);
  store.db.prepare('INSERT INTO review_jobs VALUES(1,1,1,?,?)').run('queued', 'invalid-time');
  assert.throws(() => ageSeconds(store, 'review_jobs', ['queued']), { code: 'EMETRICSUNAVAILABLE', status: 503 });
  assert.throws(() => ageSeconds(store, 'missing_table', ['queued']), { code: 'EMETRICSUNAVAILABLE' });
  assert.throws(() => ageSeconds({ db: { prepare() { throw new Error('private database detail'); } } }, 'review_jobs', ['queued']), error =>
    error.status === 503 && !error.message.includes('private database detail'));
  assert.throws(() => oldestAgeSeconds(undefined), { code: 'EMETRICSUNAVAILABLE' });
  assert.throws(() => oldestAgeSeconds(''), { code: 'EMETRICSUNAVAILABLE' });
  assert.throws(() => oldestAgeSeconds(null, NaN), { code: 'EMETRICSUNAVAILABLE' });
  assert.equal(oldestAgeSeconds('2026-01-01T00:00:00.000Z', Date.parse('2026-01-01T00:00:20.500Z')), 20.5);
});
test('split covering-index aggregation preserves terminal, active and missing projects', t => {
  const store = fixture(t);
  const insert = store.db.prepare('INSERT INTO review_jobs VALUES(?,?,?,?,?)');
  for (const [id, pid, state] of [[1,1,'pass'],[2,1,'queued'],[3,2,'running'],[4,3,'failed']])
    insert.run(id, pid, id, state, '2026-01-01T00:00:00.000Z');
  const rows = repositoryCounts(store.db, [1,2,3,4], 256);
  assert.deepEqual(rows.map(row => [row.project_id, row.total, row.queued, row.running]), [[1,2,1,0],[2,1,0,1],[3,1,0,0]]);
  const body = renderRepositoryMetrics(store, { projectIds: [1,2,3], now: Date.parse('2026-01-01T00:00:10Z') });
  assert.match(body, /oldest_queue_age_seconds\{project_id="1"\} 10/);
  assert.match(body, /oldest_queue_age_seconds\{project_id="3"\} 0/);
  assert.doesNotMatch(body, /project_id="4"/);
  assert.throws(() => renderRepositoryMetrics(store, { projectIds: ['1'] }), /Unsafe/);
  assert.throws(() => renderRepositoryMetrics(store, { projectIds: [true] }), /Unsafe/);
  assert.match(renderRepositoryMetrics(store, { projectIds: [] }), /metrics_complete 1/);
});
test('repository metric corruption never turns an unknown queue age into zero', t => {
  const store = fixture(t);
  store.db.exec("INSERT INTO review_jobs VALUES(1,1,1,'queued','corrupt')");
  assert.throws(() => renderRepositoryMetrics(store), { code: 'EMETRICSUNAVAILABLE' });
});
