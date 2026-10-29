'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { Store } = require('../src/db');
const { createServiceReviewReceipt } = require('../src/review');
const { readPublicationEvidence, positiveId } = require('../src/publication-evidence');
const { loadStructuredConfig, loadConfig, storagePaths, publicationIdentity } = require('../src/config');
const { resolveDbPath } = require('../src/admin');

const headSha = 'a'.repeat(40), startSha = 'b'.repeat(40), baseSha = 'c'.repeat(40);
const config = { gitlabApiUrl: 'https://gitlab.example.invalid/api/v4', statusName: 'review' };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-publication-evidence-'));
  const dbPath = path.join(dir, 'review-service.sqlite'), store = new Store(dbPath);
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ schemaVersion: 8, server: { dataDir: dir }, gitlab: { baseUrl: 'https://gitlab.example.invalid', projects: [7], statusName: 'review' } }));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let next = 0;
  function complete({ mrIid = 9, pipelineId = 123, model = true, phase = 'ack', head = headSha } = {}) {
    const jobId = store.enqueue({ projectId: 7, mrIid, trigger: 'command', dedupeKey: `command-${++next}`, headSha: head, startSha });
    store.bindJobSnapshot(jobId, { baseSha, startSha, headSha: head, sourceBranch: 'feature', targetBranch: 'main', statusProjectId: 7, pipelineId });
    const review = { verdict: 'pass', summary: 'private finding body must not appear', coverageComplete: true, findings: [], allFindings: [], usage: {},
      ...(model ? { chunkCount: 1, codexModel: 'test-model', codexVersion: 'codex-cli 9.9.9', usage: { inputTokens: 10, outputTokens: 2 }, reviewSubjectFingerprint: 'd'.repeat(64), evidenceManifestDigest: 'e'.repeat(64) } : {}) };
    const policy = { source: 'service-default', fingerprint: 'f'.repeat(64) };
    const projection = model ? createServiceReviewReceipt({ projectId: 7, iid: mrIid, startSha, headSha: head, diffFingerprint: '1'.repeat(64) }, review, policy) : null;
    const runId = store.saveRunWithOutbox(jobId, review, 1, policy, [{ projectId: 7, mrIid, type: 'status', dedupeKey: `job:${jobId}:status:final`,
      payload: { jobId, startSha, statusName: 'review', statusProjectId: 7, headSha: head, state: 'success', description: 'passed', ref: 'feature', pipelineId } }], projection);
    store.finishJob(jobId, 'pass');
    const raw = store.db.prepare('SELECT * FROM publication_outbox WHERE run_id=?').get(runId), item = { ...raw, payload: JSON.parse(raw.payload_json) };
    if (phase === 'pending') return { jobId, runId, item };
    store.db.prepare("UPDATE publication_outbox SET status='publishing',attempt=1 WHERE id=?").run(item.id);
    const attempt = store.statusWrites.begin(item, config);
    if (phase === 'ack') {
      store.statusWrites.settle(attempt, { result: { id: 1000 + item.id } });
      store.statusWrites.complete(item, config, 1000 + item.id, 1000);
    } else if (phase === 'unknown') {
      store.statusWrites.settle(attempt, { error: { code: 'EGITLABNETWORK' } });
    } else if (phase === 'rejected') {
      store.statusWrites.settle(attempt, { error: { code: 'EGITLABHTTP', status: 403 } });
      store.failPublication(item.id, 'EGITLABHTTP');
    }
    return { jobId, runId, item, attempt };
  }
  function read(mrIid = 9) { return readPublicationEvidence(dbPath, config, 7, mrIid); }
  function cli(...args) {
    const env = { ...process.env, CODEX_REVIEW_CONFIG_FILE: configFile, GITLAB_API_TOKEN_FILE: path.join(dir, 'must-not-read-secret'), NODE_NO_WARNINGS: '1' };
    delete env.GITLAB_API_TOKEN;
    const output = spawnSync(process.execPath, [path.join(__dirname, '../src/admin-cli.js'), 'publication-evidence', ...args], { env, encoding: 'utf8' });
    assert.equal(output.error, undefined, output.error?.message);
    return { ...output, value: JSON.parse(output.stdout) };
  }
  return { dir, dbPath, store, configFile, complete, read, cli };
}

function assertUnbound(value) {
  assert.equal(value.mergeAuthorized, false);
  assert.equal(value.refTransactionBound, false);
  assert.equal(value.purpose, 'local-publication-evidence');
}

test('latest complete receipt and acknowledged exact publication remain unbound and are read without writes', t => {
  const f = fixture(t), current = f.complete();
  const before = fs.readFileSync(f.dbPath), ledgerBefore = f.store.db.prepare('SELECT * FROM status_write_attempts').all();
  const result = f.read();
  assertUnbound(result);
  assert.equal(result.decision, 'evidence_complete_unbound');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.generation.jobId, current.jobId);
  assert.equal(result.review.receiptState, 'valid');
  assert.equal(result.publication.acknowledged, true);
  assert.deepEqual(fs.readFileSync(f.dbPath), before);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM status_write_attempts').all(), ledgerBefore);
  assert.doesNotMatch(JSON.stringify(result), /private finding body|test-model|codex-cli|sqlite|description/);
});

test('no-inference receipt exception is narrow and actual model evidence requires a valid matching receipt', t => {
  const f = fixture(t), current = f.complete({ model: false });
  assert.equal(f.read().review.receiptState, 'not_required_no_inference');
  f.store.db.prepare("UPDATE review_runs SET chunk_count=1,codex_model='test-model',input_tokens=10 WHERE id=?").run(current.runId);
  const missing = f.read();
  assert.equal(missing.decision, 'blocked');
  assert.ok(missing.reasons.includes('review_receipt_invalid'));
});

test('new same-SHA review and new run cannot reuse a previous completed generation', t => {
  const f = fixture(t), first = f.complete();
  const newer = f.store.enqueue({ projectId: 7, mrIid: 9, trigger: 'command', dedupeKey: 'new-same-head', headSha, startSha });
  f.store.bindJobSnapshot(newer, { baseSha, startSha, headSha, sourceBranch: 'feature', targetBranch: 'main', statusProjectId: 7, pipelineId: 123 });
  const result = f.read();
  assert.equal(result.generation.jobId, newer);
  assert.notEqual(result.generation.jobId, first.jobId);
  assert.equal(result.decision, 'blocked');
  assert.ok(result.reasons.includes('review_run_missing'));
});

test('persisted run and final outbox before finishJob cannot imply completed review', t => {
  const f = fixture(t), current = f.complete();
  f.store.db.prepare("UPDATE review_jobs SET status='running' WHERE id=?").run(current.jobId);
  assert.ok(f.read().reasons.includes('review_job_not_complete'));
});

test('started and unknown attempts span MR and implicit/explicit pipeline aliases', t => {
  for (const phase of ['started', 'unknown']) {
    const f = fixture(t);
    const old = f.complete({ mrIid: 8, pipelineId: null, phase });
    f.complete({ mrIid: 9, pipelineId: 123 });
    const result = f.read();
    assert.equal(result.decision, 'blocked');
    assert.ok(result.reasons.includes('status_write_unresolved'));
    assert.equal(result.uncertainty.unresolvedAttempts, 1);
    assert.equal(result.uncertainty.attempts[0].id, old.attempt.id);
  }
});

test('a newer cross-MR shared-domain job blocks before a target has been registered', t => {
  const f = fixture(t);
  f.complete();
  const newer = f.store.enqueue({ projectId: 7, mrIid: 10, trigger: 'command', dedupeKey: 'shared-new', headSha, startSha });
  f.store.bindJobSnapshot(newer, { baseSha, startSha, headSha, sourceBranch: 'feature', targetBranch: 'main', statusProjectId: 7, pipelineId: null });
  const result = f.read();
  assert.ok(result.reasons.includes('shared_status_generation_newer'));
  assert.equal(result.generation.latestSharedJobId, newer);
});

test('definite older rejection does not become uncertainty, while current rejection cannot be acknowledgement', t => {
  const f = fixture(t);
  f.complete({ mrIid: 8, phase: 'rejected' });
  const current = f.complete();
  assert.equal(f.read().decision, 'evidence_complete_unbound');
  f.store.db.prepare("UPDATE status_write_attempts SET outcome='rejected',remote_id='' WHERE id=?").run(current.attempt.id);
  assert.ok(f.read().reasons.includes('current_status_acknowledgement_missing'));
});

test('legacy unadopted uncertainty and incomplete orphan scope impose a global hold without adoption', t => {
  const f = fixture(t);
  f.complete();
  const legacy = f.store.enqueuePublication({ projectId: 99, mrIid: 99, type: 'status', dedupeKey: 'orphan', payload: {} });
  f.store.db.prepare("UPDATE publication_outbox SET payload_json='{}',attempt=1,status='failed',error_code='EGITLABHTTP' WHERE id=?").run(legacy);
  let result = f.read();
  assert.ok(result.reasons.includes('status_history_unadopted'));
  assert.equal(result.uncertainty.unadoptedStatusOutboxes, 1);
  assert.equal(f.store.db.prepare('SELECT payload_json FROM publication_outbox WHERE id=?').get(legacy).payload_json, '{}');
  const item = { id: legacy, project_id: 99, mr_iid: 99, action_type: 'status', payload: {} }, key = f.store.statusWrites.registerOrphan(item, config);
  f.store.db.prepare("INSERT INTO status_write_attempts(target_key,outbox_id,payload_json,outcome,started_at) VALUES(?,?,'{}','uncertain','2026-10-25')").run(key, legacy);
  result = f.read();
  assert.ok(result.reasons.includes('unknown_status_scope'));
  assert.equal(result.uncertainty.unknownScopeTargets, 1);
});

test('ACK and retained target payloads bind exact run, MR, state and pipeline identities', t => {
  for (const [table, column, mutate] of [
    ['status_write_attempts', 'payload_json', p => ({ ...p, pipelineId: 999 })],
    ['status_write_attempts', 'payload_json', p => ({ ...p, state: 'failed' })],
    ['status_publication_targets', 'latest_item_json', p => ({ ...p, run_id: p.run_id + 1 })],
    ['status_publication_targets', 'latest_item_json', p => ({ ...p, mr_iid: 999 })],
    ['status_publication_targets', 'latest_item_json', p => ({ ...p, payload: { ...p.payload, pipelineId: 999 } })]
  ]) {
    const f = fixture(t); f.complete();
    const row = f.store.db.prepare(`SELECT ${column} value FROM ${table}`).get();
    f.store.db.prepare(`UPDATE ${table} SET ${column}=?`).run(JSON.stringify(mutate(JSON.parse(row.value))));
    assert.equal(f.read().decision, 'blocked', `${table}.${column}`);
  }
});

test('pending final publication, incomplete receipt and changed config identity fail closed', t => {
  const f = fixture(t), current = f.complete({ phase: 'pending' });
  assert.ok(f.read().reasons.includes('final_status_not_published'));
  const row = f.store.db.prepare('SELECT receipt_json FROM review_runs WHERE id=?').get(current.runId), receipt = JSON.parse(row.receipt_json);
  receipt.coverageVerdict = 'incomplete';
  f.store.db.prepare('UPDATE review_runs SET receipt_json=? WHERE id=?').run(JSON.stringify(receipt), current.runId);
  assert.ok(f.read().reasons.includes('review_receipt_invalid'));
  assert.equal(readPublicationEvidence(f.dbPath, { ...config, gitlabApiUrl: 'https://other.example.invalid/api/v4' }, 7, 9).decision, 'blocked');
});

test('CLI exits 2 for blocked, 3 for complete-unbound, 1 for invalid input, without loading credentials', t => {
  const f = fixture(t);
  let result = f.cli('7', '9');
  assert.equal(result.status, 2); assertUnbound(result.value);
  f.complete();
  result = f.cli('7', '9');
  assert.equal(result.status, 3); assertUnbound(result.value);
  for (const args of [['7junk','9'],['7','9','extra'],['9007199254740992','9'],['7'],['0','9']]) {
    result = f.cli(...args);
    assert.equal(result.status, 1, args.join(' ')); assertUnbound(result.value);
    assert.equal(result.value.decision, 'error');
    assert.doesNotMatch(result.stdout + result.stderr, /must-not-read-secret|private finding body/);
  }
});

test('read-only command refuses incompatible or missing databases without migration or creation', t => {
  const f = fixture(t);
  f.store.db.exec('PRAGMA user_version=9');
  const result = f.cli('7','9');
  assert.equal(result.status, 1); assert.equal(result.value.errorCode, 'EDBSCHEMA');
  assert.equal(f.store.schemaVersion(), 9);
  const missing = path.join(f.dir, 'missing.sqlite');
  assert.throws(() => readPublicationEvidence(missing, config, 7, 9), { code: 'EPUBLICATIONEVIDENCE' });
  assert.equal(fs.existsSync(missing), false);
});

test('current invocation recomputes evidence and never clears an unknown after matching readback', t => {
  const f = fixture(t), current = f.complete();
  assert.equal(f.read().decision, 'evidence_complete_unbound');
  f.store.db.prepare("UPDATE status_write_attempts SET outcome='uncertain' WHERE id=?").run(current.attempt.id);
  f.store.db.prepare("UPDATE status_publication_targets SET observation_json='{\"kind\":\"match\",\"remoteIdMatches\":true}'").run();
  assert.equal(f.read().decision, 'blocked');
  assert.equal(f.store.db.prepare('SELECT outcome FROM status_write_attempts WHERE id=?').get(current.attempt.id).outcome, 'uncertain');
});

test('the readonly evidence snapshot stays coherent when a writer creates a newer generation between reads', t => {
  const f = fixture(t), current = f.complete(), original = DatabaseSync.prototype.prepare;
  let inserted = false, newer;
  DatabaseSync.prototype.prepare = function(sql, ...args) {
    const statement = original.call(this, sql, ...args);
    if (sql.startsWith('SELECT * FROM review_jobs WHERE project_id=')) {
      const get = statement.get.bind(statement);
      statement.get = (...values) => {
        const row = get(...values);
        if (!inserted) {
          inserted = true;
          newer = f.store.enqueue({ projectId: 7, mrIid: 9, trigger: 'command', dedupeKey: 'concurrent-generation', headSha, startSha });
          f.store.bindJobSnapshot(newer, { baseSha, startSha, headSha, sourceBranch: 'feature', targetBranch: 'main', statusProjectId: 7, pipelineId: 123 });
        }
        return row;
      };
    }
    return statement;
  };
  let result;
  try { result = f.read(); } finally { DatabaseSync.prototype.prepare = original; }
  assert.equal(inserted, true);
  assert.equal(result.generation.jobId, current.jobId);
  assert.equal(result.decision, 'evidence_complete_unbound');
  const fresh = f.read();
  assert.equal(fresh.generation.jobId, newer);
  assert.equal(fresh.decision, 'blocked');
});

test('equivalent but noncanonical URL domains and unsupported protocol types cannot conceal unknown history', t => {
  const f = fixture(t), current = f.complete();
  const row = f.store.db.prepare('SELECT * FROM status_publication_targets').get(), identity = JSON.parse(row.identity_json);
  identity.apiUrl = 'https://GITLAB.example.invalid:443/api/v4';
  const aliasKey = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const alias = { ...row, target_key: aliasKey, identity_json: JSON.stringify(identity), projection_state: 'uncertain' }, columns = Object.keys(alias);
  f.store.db.prepare(`INSERT INTO status_publication_targets(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...Object.values(alias));
  f.store.db.prepare("INSERT INTO status_write_attempts(target_key,outbox_id,job_id,payload_json,outcome,started_at) VALUES(?,?,?,'{}','uncertain','2026-10-25')")
    .run(aliasKey, current.item.id, current.jobId);
  assert.ok(f.read().reasons.includes('unknown_status_scope'));
  for (const protocol of [2, true, '1']) {
    const id = f.store.enqueuePublication({ projectId: 99, mrIid: 99, type: 'status', dedupeKey: `unsupported-${typeof protocol}-${protocol}`, payload: {} });
    f.store.db.prepare("UPDATE publication_outbox SET payload_json=?,attempt=1,status='failed',error_code='EGITLABNETWORK' WHERE id=?")
      .run(JSON.stringify({ statusPublicationProtocol: protocol }), id);
  }
  const unsupportedAck = f.store.enqueuePublication({ projectId: 99, mrIid: 99, type: 'status', dedupeKey: 'unsupported-ack', payload: {} });
  f.store.db.prepare("UPDATE publication_outbox SET payload_json='{\"statusPublicationProtocol\":2}',attempt=1,status='published',remote_id='123' WHERE id=?").run(unsupportedAck);
  const result = f.read();
  assert.equal(result.uncertainty.unadoptedStatusOutboxes, 4);
  assert.ok(result.reasons.includes('status_history_unadopted'));
});

test('strict identifier parser and shared config/storage identity preserve runtime semantics', t => {
  for (const id of [true, null, {}, '7.0', ' 7', '7e1', '-1', Infinity]) assert.throws(() => positiveId(id), { code: 'EADMININPUT' });
  const f = fixture(t), old = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]; Object.assign(process.env, old); });
  process.env.CODEX_REVIEW_CONFIG_FILE = f.configFile;
  process.env.GITLAB_API_TOKEN = 'synthetic-config-test-token';
  process.env.GITLAB_WEBHOOK_SIGNING_TOKEN = 'whsec_' + Buffer.alloc(32, 7).toString('base64');
  for (const dataDir of [undefined, '', '  ', f.dir]) {
    const input = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
    input.server = dataDir === undefined ? {} : { dataDir };
    fs.writeFileSync(f.configFile, JSON.stringify(input));
    const structured = loadStructuredConfig(), runtime = loadConfig();
    assert.equal(resolveDbPath(structured), runtime.dbPath);
    assert.equal(storagePaths(structured.value.server).dataDir, runtime.dataDir);
    assert.equal(publicationIdentity(structured.value.gitlab).gitlabApiUrl, runtime.gitlabApiUrl);
    assert.equal(publicationIdentity(structured.value.gitlab).statusName, runtime.statusName);
  }
});

test('new target-bound generations qualify while migrated unbound generations stay blocked', t => {
 const e=fixture(t),item=e.complete();
 const complete=e.read();
 assert.equal(complete.decision,'evidence_complete_unbound');
 assert.equal(complete.source.targetBranch,'main');
 e.store.db.prepare("UPDATE review_jobs SET target_branch='' WHERE id=?").run(item.jobId);
 const historical=e.read();
 assert.equal(historical.decision,'blocked');
 assert.ok(historical.reasons.includes('source_identity_incomplete'));
 assert.equal(historical.mergeAuthorized,false);
 assert.equal(historical.refTransactionBound,false);
});
