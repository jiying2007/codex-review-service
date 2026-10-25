'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('../src/db');
const { Publisher } = require('../src/publication');
const { GitLabClient } = require('../src/gitlab');
const { statusTarget } = require('../src/status-write-store');
const { drain, diagnostics, retryTerminal } = require('../src/admin');
const { createReadiness, renderMetrics } = require('../src/http');
const { feishuPayload } = require('../src/notification');

const refs = { base_sha: 'b', start_sha: 's', head_sha: 'h' };

async function fixture(t, { delayOld = false, rejectNewOnce = false, maxPublishAttempts = 3 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-uncertainty-'));
  const dbPath = path.join(dir, 'service.sqlite');
  let store = new Store(dbPath), remote = null, releaseOld, oldCommitted;
  const gate = new Promise(resolve => { releaseOld = resolve; });
  const committed = new Promise(resolve => { oldCommitted = resolve; });
  const writes = [], reads = [], trace = [];
  let statusesOverride = null, onRead = null, ackResponse, rejected = false, version = '19.1.0';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const respond = (status, value, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET') {
      reads.push(url.pathname);
      if (url.pathname.endsWith('/version')) return respond(200, { version });
      if (url.pathname.endsWith('/user')) return respond(200, { id: 42, username: 'bot' });
      if (url.pathname.includes('/merge_requests/')) return respond(200, { state: 'opened', diff_refs: refs });
      if (url.pathname.endsWith('/statuses')) {
        assert.equal(url.searchParams.get('pipeline_id'), '123');
        assert.equal(url.searchParams.get('name'), 'review');
        assert.equal(url.searchParams.get('ref'), 'feat');
        assert.equal(url.searchParams.get('all'), 'false');
        onRead?.();
        return respond(200, statusesOverride === null ? (remote ? [remote] : []) : statusesOverride);
      }
      return respond(404, {});
    }
    assert.equal(req.method, 'POST');
    assert.equal(url.pathname, '/api/v4/projects/7/statuses/h');
    const state = url.searchParams.get('state'), description = url.searchParams.get('description');
    const attempt = store.db.prepare('SELECT * FROM status_write_attempts ORDER BY id DESC LIMIT 1').get();
    assert.equal(attempt.outcome, 'started');
    writes.push({ state, description, attemptId: attempt.id, pipeline: url.searchParams.get('pipeline_id') });
    trace.push({ event: 'received', state, description });
    if (rejectNewOnce && description === 'new' && !rejected) { rejected = true; return respond(409, {}); }
    if (delayOld && description === 'old') await gate;
    const value = { id: writes.length, sha: 'h', ref: 'feat', name: 'review', status: state, description,
      pipeline_id: 123, author: { id: 42, username: 'bot' } };
    remote = value;
    trace.push({ event: 'committed', state, description });
    respond(201, ackResponse === undefined ? value : ackResponse);
    if (description === 'old') oldCommitted();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { statusName: 'review', botUsername: 'bot', gitlabApiUrl: `http://127.0.0.1:${server.address().port}/api/v4`,
    gitlabToken: 'synthetic-token', gitlabRequestTimeoutMs: 1000, gitlabStatusRetries: 2, gitlabRequestsPerSecond: 1000,
    gitlabMaxPages: 5, maxPublishAttempts, retryBaseDelayMs: 100, retryMaxDelayMs: 1000, publisherConcurrency: 1,
    publisherPollIntervalMs: 50, reconcileIntervalMs: 60000 };
  let client, publisher;
  function publisherForStore() { client = new GitLabClient(config); publisher = new Publisher({ config, store, gitlab: client, logger: {} }); }
  publisherForStore();
  t.after(async () => {
    releaseOld();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    get store() { return store; }, get publisher() { return publisher; }, get client() { return client; },
    get remote() { return remote; }, set remote(value) { remote = value; }, config, writes, reads, trace, dir,
    set statuses(value) { statusesOverride = value; }, set onRead(value) { onRead = value; }, set ackResponse(value) { ackResponse = value; }, set version(value) { version = value; client.versionInfo = null; },
    enqueue(state, description, { pipelineId = 123, mrIid = 9 } = {}) {
      const jobId = store.enqueue({ projectId: 7, mrIid, trigger: 'command', dedupeKey: description, headSha: 'h', startSha: 's' });
      store.bindJobSnapshot(jobId, { baseSha: 'b', startSha: 's', headSha: 'h', sourceBranch: 'feat', statusProjectId: 7, pipelineId });
      store.finishJob(jobId, state === 'success' ? 'pass' : 'blocked');
      const id = store.enqueuePublication({ projectId: 7, mrIid, type: 'status', dedupeKey: `job:${jobId}:status:final`,
        payload: { jobId, statusName: 'review', startSha: 's', statusProjectId: 7, headSha: 'h', ref: 'feat', pipelineId, state, description } });
      return id;
    },
    row(id) { return store.db.prepare('SELECT * FROM publication_outbox WHERE id=?').get(id); },
    target() { const row = store.db.prepare('SELECT target_key FROM status_publication_targets LIMIT 1').get(); return store.statusWrites.target(row.target_key); },
    due() { store.db.exec("UPDATE status_publication_targets SET next_reconcile_at='2000-01-01'"); },
    restart() { store.close(); store = new Store(dbPath); store.recoverPublications(); publisherForStore(); },
    async release() { releaseOld(); await committed; },
    seedUnknown() {
      const id = this.enqueue('success', 'seed-unknown'), item = store.claimPublication();
      const attempt = store.statusWrites.begin(item, config);
      store.statusWrites.settle(attempt, { error: Object.assign(new Error('lost response'), { code: 'EGITLABNETWORK' }) });
      store.statusWrites.hold(item, config, 'ESTATUSUNCERTAIN', 0);
      return id;
    }
  };
}

test('ordinary acknowledged status keeps existing behavior and does not start a readback/write loop', async t => {
  const s = await fixture(t), id = s.enqueue('success', 'normal');
  await s.publisher.process(s.store.claimPublication());
  assert.equal(s.row(id).status, 'published');
  assert.deepEqual(s.store.statusWrites.summary(), { unresolvedAttempts: 0, uncertainTargets: 0 });
  assert.equal(s.writes.length, 1);
  assert.equal(s.store.db.prepare('SELECT outcome FROM status_write_attempts').get().outcome, 'acknowledged');
  for (let i = 0; i < 3; i++) { s.due(); assert.deepEqual(await s.publisher.reconcileStatusPublications(), { checked: 0, repaired: 0 }); }
  assert.ok(s.reads.every(url => url.includes('/merge_requests/')));
});

test('real delayed HTTP old success cannot be called settled; restart readback repairs only the latest failed projection', async t => {
  const s = await fixture(t, { delayOld: true, rejectNewOnce: true });
  const old = s.enqueue('success', 'old', { pipelineId: null, mrIid: 9 });
  await s.publisher.process(s.store.claimPublication());
  assert.equal(s.row(old).status, 'uncertain');
  const latest = s.enqueue('failed', 'new', { pipelineId: 123, mrIid: 10 });
  await s.publisher.process(s.store.claimPublication());
  assert.equal(s.row(latest).status, 'uncertain');
  assert.equal(s.remote.status, 'failed');
  assert.deepEqual(s.store.db.prepare('SELECT outcome FROM status_write_attempts ORDER BY id').all().map(row => row.outcome), ['uncertain', 'rejected', 'acknowledged']);
  const posts = s.writes.length;
  s.due(); assert.deepEqual(await s.publisher.reconcileStatusPublications(), { checked: 1, repaired: 0 });
  assert.equal(s.target().observation.kind, 'match');
  assert.equal(s.writes.length, posts);
  assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 1);
  await s.release();
  assert.equal(s.remote.status, 'success');
  s.restart(); s.due();
  assert.deepEqual(await s.publisher.reconcileStatusPublications(), { checked: 1, repaired: 1 });
  assert.equal(s.remote.status, 'failed');
  assert.equal(s.row(latest).status, 'uncertain');
  assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 1);
  s.due(); await s.publisher.reconcileStatusPublications();
  assert.equal(s.writes.length, posts + 1);
  assert.equal(s.target().observation.kind, 'match');
  assert.equal(s.target().observation.remoteIdMatches, true);
  assert.deepEqual(s.trace.filter(event => event.event === 'committed').map(event => event.state), ['failed', 'success', 'failed']);
  assert.equal(new Set(s.writes.map(write => write.attemptId)).size, s.writes.length);
  s.store.db.exec("UPDATE review_jobs SET finished_at='2000-01-01'; UPDATE status_publication_targets SET updated_at='2000-01-01'; UPDATE status_write_attempts SET started_at='2000-01-01',finished_at='2000-01-01'");
  s.store.prune({ dataRetentionDays: 1, webhookRetentionDays: 1 });
  assert.equal(s.store.db.prepare('SELECT COUNT(*) count FROM review_jobs').get().count, 2);
  assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 1);
  const backupPath = path.join(s.dir, 'backup.sqlite');
  s.store.db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  const backup = new Store(backupPath);
  try { backup.recoverPublications(); assert.equal(backup.statusWrites.summary().unresolvedAttempts, 1); assert.equal(backup.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); }
  finally { backup.close(); }
  s.restart(); assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 1);
});

test('known HTTP 409 attempts remain rejected rather than uncertain after retry success', async t => {
  const s = await fixture(t, { rejectNewOnce: true }), id = s.enqueue('failed', 'new');
  await s.publisher.process(s.store.claimPublication());
  assert.equal(s.row(id).status, 'published');
  assert.deepEqual(s.store.db.prepare('SELECT outcome FROM status_write_attempts ORDER BY id').all().map(row => row.outcome), ['rejected', 'acknowledged']);
  assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 0);
});

test('interrupted durable intent remains unknown across restart and a matching newer projection', async t => {
  const s = await fixture(t);
  const old = s.enqueue('success', 'interrupted'), item = s.store.claimPublication();
  s.store.statusWrites.begin(item, s.config);
  s.restart();
  assert.equal(s.row(old).status, 'uncertain');
  assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 1);
  assert.equal(s.writes.length, 0);
  const latest = s.enqueue('failed', 'acknowledged');
  await s.publisher.process(s.store.claimPublication());
  assert.equal(s.row(latest).status, 'uncertain');
  s.due(); await s.publisher.reconcileStatusPublications();
  assert.equal(s.writes.length, 1);
  assert.equal(s.row(latest).status, 'uncertain');
});

test('acknowledged HTTP transport interrupted before local completion is confirmed without another POST', async t => {
  const s = await fixture(t), id = s.enqueue('failed', 'ack-before-crash'), item = s.store.claimPublication();
  let attempt;
  await s.client.setCommitStatus(7, 'h', 'failed', 'ack-before-crash', 'feat', 123, {
    beforeSend() { attempt = s.store.statusWrites.begin(item, s.config); },
    onAttemptSettled(value) { s.store.statusWrites.settle(attempt, value); }
  });
  assert.equal(s.row(id).status, 'publishing');
  s.restart();
  assert.equal(s.row(id).status, 'uncertain');
  assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 0);
  s.due(); await s.publisher.reconcileStatusPublications();
  assert.equal(s.row(id).status, 'published');
  assert.equal(s.writes.length, 1);
});

test('queued recovery cannot replay a newer acknowledged generation after it acquires the status lock', async t => {
  const s = await fixture(t), oldId = s.enqueue('failed', 'old-ack-before-crash'), oldItem = s.store.claimPublication();
  let attempt;
  await s.client.setCommitStatus(7, 'h', 'failed', 'old-ack-before-crash', 'feat', 123, {
    beforeSend() { attempt = s.store.statusWrites.begin(oldItem, s.config); },
    onAttemptSettled(value) { s.store.statusWrites.settle(attempt, value); }
  });
  s.restart();
  assert.equal(s.row(oldId).status, 'uncertain');
  assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 0);
  const latestId = s.enqueue('failed', 'new-ack');
  let entered, unlock;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { unlock = resolve; });
  const getMergeRequest = s.client.getMergeRequest.bind(s.client);
  let firstSnapshot = true;
  s.client.getMergeRequest = async (...args) => {
    if (firstSnapshot) { firstSnapshot = false; entered(); await gate; }
    return getMergeRequest(...args);
  };
  const publishing = s.publisher.process(s.store.claimPublication());
  await started;
  s.due();
  // If the old claim is incorrectly retained, this lagging read would cause
  // an unnecessary second write of the new generation.
  s.statuses = [];
  const reconciling = s.publisher.reconcileStatusPublications();
  unlock();
  await publishing;
  assert.deepEqual(await reconciling, { checked: 1, repaired: 0 });
  assert.equal(s.row(latestId).status, 'published');
  assert.equal(s.writes.length, 2, 'one old acknowledged write and one new write');
  assert.equal(s.reads.filter(url => url.endsWith('/statuses')).length, 0);
  assert.deepEqual(s.store.statusWrites.summary(), { unresolvedAttempts: 0, uncertainTargets: 0 });
});

test('legacy adoption preserves unknown attempts when outbox order reverses job generation order', async t => {
  const s = await fixture(t), oldId = s.enqueue('success', 'old-job'), old = s.row(oldId);
  const latestId = s.enqueue('failed', 'new-job');
  s.store.db.prepare('DELETE FROM publication_outbox WHERE id=?').run(oldId);
  const oldPayload = JSON.parse(old.payload_json);
  const laterOutboxId = s.store.enqueuePublication({ projectId: 7, mrIid: 9, type: 'status', dedupeKey: 'late-old-job-final', payload: oldPayload });
  assert.ok(laterOutboxId > latestId);
  s.store.db.exec("UPDATE publication_outbox SET payload_json=json_remove(payload_json,'$.statusPublicationProtocol'),status='pending',attempt=1,error_code='EGITLABNETWORK'");
  s.publisher.recoverLegacyStatuses();
  assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 2);
  assert.equal(s.target().latest_outbox_id, latestId);
  assert.equal(s.target().latest_job_id, JSON.parse(s.row(latestId).payload_json).jobId);
  assert.equal(s.row(laterOutboxId).status, 'uncertain');
  s.due(); await s.publisher.reconcileStatusPublications();
  assert.deepEqual(s.writes.map(value => value.description), ['new-job']);
  assert.equal(s.row(latestId).status, 'uncertain');
  s.restart(); s.publisher.recoverLegacyStatuses();
  assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 2);
});

for (const incompleteTarget of [false, true]) test(`orphan legacy uncertainty survives without inventing a job identity (${incompleteTarget ? 'unknown target scope' : 'exact target'})`, async t => {
  const s = await fixture(t), orphanId = s.enqueue('success', 'orphan');
  const payload = JSON.parse(s.row(orphanId).payload_json);
  s.store.db.prepare('DELETE FROM review_jobs WHERE id=?').run(payload.jobId);
  delete payload.statusPublicationProtocol;
  if (incompleteTarget) delete payload.statusProjectId;
  s.store.db.prepare("UPDATE publication_outbox SET payload_json=?,attempt=1,error_code='EGITLABNETWORK' WHERE id=?").run(JSON.stringify(payload), orphanId);
  s.publisher.recoverLegacyStatuses();
  assert.equal(s.row(orphanId).status, 'uncertain');
  assert.equal(s.row(orphanId).error_code, 'ELEGACYSTATUSORPHAN');
  assert.equal(s.store.db.prepare('SELECT job_id FROM status_write_attempts LIMIT 1').get().job_id, null);
  const currentId = s.enqueue('failed', 'new-valid-job');
  await s.publisher.process(s.store.claimPublication());
  assert.equal(s.row(currentId).status, 'uncertain');
  assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 1);
  s.restart(); s.publisher.recoverLegacyStatuses();
  assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 1);
  assert.ok(s.writes.every(value => value.description === 'new-valid-job'));
});

for (const code of ['EGITLABJSON','EGITLABOUTPUT','EGITLABHTTP']) test(`legacy ${code} failure cannot lose a possibly committed status during adoption`, async t => {
  const s = await fixture(t), oldId = s.enqueue('success', 'old-failure');
  s.store.db.prepare("UPDATE publication_outbox SET payload_json=json_remove(payload_json,'$.statusPublicationProtocol'),status='failed',attempt=1,error_code=? WHERE id=?").run(code, oldId);
  const currentId = s.enqueue('failed', 'new');
  s.publisher.recoverLegacyStatuses();
  await s.publisher.process(s.store.claimPublication());
  assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 1);
  assert.equal(s.row(currentId).status, 'uncertain');
  assert.equal(s.writes.length, 1);
});

test('administrative retry resetting a legacy attempt counter cannot bypass startup uncertainty adoption', async t => {
  const s = await fixture(t), oldId = s.enqueue('success', 'old-admin-retry');
  s.store.db.prepare("UPDATE publication_outbox SET payload_json=json_remove(payload_json,'$.statusPublicationProtocol'),status='failed',attempt=1,error_code='EGITLABNETWORK' WHERE id=?").run(oldId);
  retryTerminal(s.store, 'publication', oldId);
  assert.equal(s.row(oldId).attempt, 0);
  const currentId = s.enqueue('failed', 'new');
  s.publisher.recoverLegacyStatuses();
  await s.publisher.process(s.store.claimPublication());
  assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 1);
  assert.equal(s.row(currentId).status, 'uncertain');
  assert.deepEqual(s.writes.map(value => value.state), ['failed']);
});

test('readback ambiguity never repairs or settles another target, owner, or unsupported pipeline', async t => {
  const s = await fixture(t); s.seedUnknown(); s.enqueue('failed', 'new');
  await s.publisher.process(s.store.claimPublication());
  const good = structuredClone(s.remote), writes = s.writes.length;
  for (const changed of [{ sha: 'other' }, { ref: 'other' }, { name: 'other' }, { pipeline_id: 456 }, { author: { id: 43, username: 'bot' } }, { id: null }]) {
    s.statuses = [{ ...good, ...changed, status: 'success' }]; s.due();
    assert.deepEqual(await s.publisher.reconcileStatusPublications(), { checked: 1, repaired: 0 });
    assert.equal(s.target().observation.kind, 'ambiguous');
  }
  s.statuses = [good, good]; s.due(); await s.publisher.reconcileStatusPublications();
  assert.equal(s.target().observation.reason, 'multiple_statuses');
  s.statuses = null; s.version = '14.6.1'; s.due(); await s.publisher.reconcileStatusPublications();
  assert.equal(s.target().observation.reason, 'pipeline_identity_unavailable');
  assert.equal(s.writes.length, writes);
  assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 1);
});

test('repair HTTP response without an acknowledgement ID remains unknown in its ledger and observation', async t => {
  const s = await fixture(t); s.seedUnknown();
  const latestId = s.enqueue('failed', 'new');
  await s.publisher.process(s.store.claimPublication());
  s.remote = { ...s.remote, status: 'success' };
  s.ackResponse = {};
  s.due();
  assert.deepEqual(await s.publisher.reconcileStatusPublications(), { checked: 1, repaired: 0 });
  assert.equal(s.writes.length, 2);
  assert.equal(s.store.db.prepare('SELECT outcome FROM status_write_attempts ORDER BY id DESC LIMIT 1').get().outcome, 'uncertain');
  assert.equal(s.target().observation.repairAcknowledged, false);
  assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 2);
  assert.equal(s.row(latestId).status, 'uncertain');
});

test('generation drift between readback and repair prevents a stale remote write', async t => {
  const s = await fixture(t); s.seedUnknown(); s.enqueue('failed', 'new');
  await s.publisher.process(s.store.claimPublication());
  s.remote = { ...s.remote, status: 'success', description: 'old' };
  const posts = s.writes.length;
  s.onRead = () => { s.onRead = null; s.enqueue('failed', 'newer-generation'); };
  s.due(); await s.publisher.reconcileStatusPublications();
  assert.equal(s.writes.length, posts);
  assert.equal(s.store.statusWrites.summary().unresolvedAttempts, 1);
});

test('repair attempts are durable and bounded, and stopping does not initiate another read or write', async t => {
  const s = await fixture(t, { maxPublishAttempts: 2 }); s.seedUnknown(); s.enqueue('failed', 'new');
  await s.publisher.process(s.store.claimPublication());
  for (let i = 0; i < 4; i++) {
    s.remote = { ...s.remote, status: 'success', description: 'late' }; s.due();
    await s.publisher.reconcileStatusPublications();
    if (i === 0) s.restart();
  }
  assert.equal(s.writes.length, 3);
  assert.equal(s.target().repair_attempts, 2);
  assert.equal(s.target().error_code, 'ESTATUSREPAIRLIMIT');
  const reads = s.reads.length;
  s.publisher.stopping = true; s.due();
  assert.deepEqual(await s.publisher.reconcileStatusPublications(), { checked: 0, repaired: 0 });
  assert.equal(s.reads.length, reads);
});

test('drain, diagnostics, notification and readiness expose uncertainty without inventing merge authority', async t => {
  const s = await fixture(t); s.seedUnknown();
  const result = await drain(s.store, 1);
  assert.equal(result.drained, false);
  assert.equal(result.stats.statusWrites.unresolvedAttempts, 1);
  assert.equal(diagnostics(s.store).counts.statusWrites.uncertainTargets, 1);
  const config = { ...s.config, readinessCacheMs: 1, workerConcurrency: 1, maxQueueDepth: 100, notificationEnabled: false };
  const service = { stopping: false, workers: [{}], active: new Map() };
  const publisher = { stopping: false, workers: [{}] };
  const ready = await createReadiness({ config, store: s.store, service, publisher, gitlab: s.client })();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.publicationUncertainty.unresolvedAttempts, 1);
  assert.match(renderMetrics(s.store, service, publisher, null, null, Date.now()), /codex_review_status_unknown_writes 1/);
  assert.match(JSON.stringify(feishuPayload({ type: 'review.completed', _publicationState: 'uncertain' })), /状态写入结果仍未确定/);
});

test('Schema 9 migration adds the durable ledger transactionally and preserves a verified rollback backup', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-schema9-')), file = path.join(dir, 'service.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let store = new Store(file);
  store.db.exec('DROP TABLE status_write_attempts; DROP TABLE status_publication_targets; DELETE FROM schema_migrations WHERE version=10; PRAGMA user_version=9;');
  store.close();
  assert.throws(() => new Store(file, { migrationHooks: { beforeCommit({ from }) { if (from === 9) throw new Error('injected crash'); } } }), error => error.code === 'EDBMIGRATION');
  let raw = new DatabaseSync(file);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 9);
  assert.equal(raw.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE name='status_write_attempts'").get().count, 0);
  raw.close();
  store = new Store(file);
  try {
    assert.equal(store.schemaVersion(), 10);
    const backup = new DatabaseSync(store.lastMigration.applied[0].backupPath, { readOnly: true });
    try { assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 9); assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); }
    finally { backup.close(); }
    assert.equal(fs.statSync(store.lastMigration.applied[0].backupPath).mode & 0o777, 0o600);
  } finally { store.close(); }
});
