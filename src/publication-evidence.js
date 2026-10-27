'use strict';

const { DatabaseSync } = require('node:sqlite');
const { CURRENT_SCHEMA_VERSION } = require('./db-migrations');
const { statusTarget, legacyStatusUncertain, UNRESOLVED_STATUS_ATTEMPT_PREDICATE } = require('./status-write-store');
const { fingerprint, validateReviewReceipt } = require('./codex-safe-core/safe-contract');

const EVIDENCE_LIMIT = 20;
const IGNORED_JOB_STATUSES = "'duplicate','unauthorized','skipped'";
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REMOTE_ID = /^[1-9]\d*$/;

function positiveId(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw Object.assign(new Error('Project and merge-request IDs must be positive safe integers.'), { code: 'EADMININPUT' });
  }
  return Number(value);
}

function evidenceBase() {
  return { schemaVersion: 1, purpose: 'local-publication-evidence', mergeAuthorized: false, refTransactionBound: false };
}

function boundedText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function validSha(value) { return typeof value === 'string' && SHA.test(value) && !/^0+$/.test(value); }

function validIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return false;
  let url;
  try { url = new URL(identity.apiUrl); } catch { return false; }
  return ['http:', 'https:'].includes(url.protocol) && url.href === identity.apiUrl && !url.username && !url.password && !url.search && !url.hash &&
    boundedText(identity.apiUrl, 4096) && Number.isSafeInteger(identity.projectId) && identity.projectId > 0 &&
    validSha(identity.headSha) && boundedText(identity.ref, 1024) && boundedText(identity.statusName, 255);
}

function parseObject(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid evidence object');
  return value;
}

function identityKey(identity) {
  return statusTarget({ payload: { statusProjectId: identity.projectId, headSha: identity.headSha, ref: identity.ref, statusName: identity.statusName } }, { gitlabApiUrl: identity.apiUrl }).key;
}

function reviewReceiptState(run, job) {
  if (!run.receipt_json && !run.receipt_fingerprint) {
    const noInference = run.chunk_count === 0 && !run.codex_model && !run.codex_version &&
      ['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens'].every(key => run[key] === 0);
    return noInference ? 'not_required_no_inference' : 'missing';
  }
  let receipt;
  try { receipt = validateReviewReceipt(parseObject(run.receipt_json)); } catch { return 'invalid'; }
  return receipt && receipt.subject.type === 'gitlab-mr' && receipt.subject.projectId === job.project_id &&
    receipt.subject.mrIid === job.mr_iid && receipt.subject.startSha === job.start_sha && receipt.subject.headSha === job.head_sha &&
    receipt.policyFingerprint === run.policy_fingerprint && receipt.model === run.codex_model && receipt.codexVersion === (run.codex_version || '') &&
    receipt.coverageVerdict === 'complete' && receipt.qualityVerdict !== 'blocked' && receipt.mechanicalGate === 'pass' &&
    receipt.readinessVerdict === 'needs_evidence' && fingerprint(receipt) === run.receipt_fingerprint ? 'valid' : 'invalid';
}

function inspectSnapshot(db, config, projectId, mrIid) {
  if (Number(db.prepare('PRAGMA user_version').get().user_version) !== CURRENT_SCHEMA_VERSION) {
    throw Object.assign(new Error('The evidence database schema is incompatible.'), { code: 'EDBSCHEMA' });
  }
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Evidence has broken references');
  const reasons = new Set();
  const result = {
    ...evidenceBase(), observedAt: new Date().toISOString(), projectId, mrIid,
    decision: 'blocked', reasons: [], source: null, generation: null, review: null, publication: null,
    uncertainty: { unresolvedAttempts: 0, attempts: [], attemptsTruncated: false, unknownScopeTargets: 0, unadoptedStatusOutboxes: 0, unadoptedOutboxIds: [], unadoptedIdsTruncated: false }
  };

  // A readonly inspection cannot adopt old or unsupported-format history.
  // Until its scope is established, every unknown is a store-wide hold.
  const legacyRows = db.prepare(`SELECT id,status,attempt,error_code,remote_id,
      CASE WHEN json_valid(payload_json) THEN json_type(payload_json,'$.statusPublicationProtocol') ELSE 'invalid_json' END AS protocol_type
    FROM publication_outbox
    WHERE action_type IN ('status','cancel_status') AND
      (CASE WHEN json_valid(payload_json) THEN (json_type(payload_json,'$.statusPublicationProtocol')='integer' AND json_extract(payload_json,'$.statusPublicationProtocol')=1) ELSE 0 END) IS NOT 1`);
  for (const row of legacyRows.iterate()) {
    const legacy = row.protocol_type === null || row.protocol_type === 'null';
    const uncertain = legacy ? legacyStatusUncertain(row) : Number(row.attempt) > 0 || Boolean(row.error_code) || row.status !== 'pending';
    if (!uncertain) continue;
    result.uncertainty.unadoptedStatusOutboxes++;
    if (result.uncertainty.unadoptedOutboxIds.length < EVIDENCE_LIMIT) result.uncertainty.unadoptedOutboxIds.push(row.id);
  }
  result.uncertainty.unadoptedIdsTruncated = result.uncertainty.unadoptedStatusOutboxes > EVIDENCE_LIMIT;
  if (result.uncertainty.unadoptedStatusOutboxes) reasons.add('status_history_unadopted');

  // Never treat a corrupt/incomplete recorded domain as a different safe domain.
  for (const row of db.prepare(`SELECT target_key,identity_json FROM status_publication_targets t
    WHERE EXISTS(SELECT 1 FROM status_write_attempts a WHERE a.target_key=t.target_key AND a.outcome IN ('started','uncertain'))`).iterate()) {
    let identity;
    try { identity = parseObject(row.identity_json); } catch { identity = null; }
    if (!validIdentity(identity) || identity.scopeUnknown || identityKey(identity) !== row.target_key) result.uncertainty.unknownScopeTargets++;
  }
  if (result.uncertainty.unknownScopeTargets) reasons.add('unknown_status_scope');

  const job = db.prepare(`SELECT * FROM review_jobs WHERE project_id=? AND mr_iid=?
    AND status NOT IN (${IGNORED_JOB_STATUSES}) ORDER BY id DESC LIMIT 1`).get(projectId, mrIid);
  if (!job) reasons.add('review_job_missing');
  if (job) {
    result.generation = { jobId: job.id, runId: null, outboxId: null, latestSharedJobId: job.id };
    const identity = { apiUrl: config.gitlabApiUrl, projectId: job.status_project_id, headSha: job.head_sha, ref: job.source_branch, statusName: config.statusName };
    const snapshotValid = validIdentity(identity) && boundedText(job.target_branch,1024) && validSha(job.start_sha) && validSha(job.base_sha) && job.head_sha.length === job.start_sha.length && job.head_sha.length === job.base_sha.length &&
      (job.pipeline_id === null || (Number.isSafeInteger(job.pipeline_id) && job.pipeline_id > 0));
    if (!snapshotValid) reasons.add('source_identity_incomplete');
    else {
      result.source = { gitlabApiUrl: identity.apiUrl, statusProjectId: identity.projectId, ref: identity.ref, targetBranch:job.target_branch, headSha: job.head_sha, startSha: job.start_sha, baseSha: job.base_sha, statusName: identity.statusName, pipelineId: job.pipeline_id };
      const key = identityKey(identity);
      const shared = db.prepare(`SELECT id FROM review_jobs WHERE id>? AND status NOT IN (${IGNORED_JOB_STATUSES})
        AND COALESCE(status_project_id,project_id)=? AND head_sha=? AND source_branch=? ORDER BY id DESC LIMIT 1`)
        .get(job.id, identity.projectId, identity.headSha, identity.ref);
      if (shared) { result.generation.latestSharedJobId = shared.id; reasons.add('shared_status_generation_newer'); }
      result.uncertainty.unresolvedAttempts = Number(db.prepare(`SELECT COUNT(*) count FROM status_write_attempts WHERE ${UNRESOLVED_STATUS_ATTEMPT_PREDICATE}`).get(key).count);
      result.uncertainty.attempts = db.prepare(`SELECT id,outbox_id AS outboxId,job_id AS jobId,outcome FROM status_write_attempts
        WHERE ${UNRESOLVED_STATUS_ATTEMPT_PREDICATE} ORDER BY id LIMIT ?`).all(key, EVIDENCE_LIMIT);
      result.uncertainty.attemptsTruncated = result.uncertainty.unresolvedAttempts > EVIDENCE_LIMIT;
      if (result.uncertainty.unresolvedAttempts) reasons.add('status_write_unresolved');

      const run = db.prepare('SELECT * FROM review_runs WHERE job_id=? ORDER BY id DESC LIMIT 1').get(job.id);
      if (!['pass', 'needs_attention'].includes(job.status)) reasons.add('review_job_not_complete');
      if (!run) reasons.add('review_run_missing');
      if (run) {
        result.generation.runId = run.id;
        const receiptState = reviewReceiptState(run, job);
        result.review = { verdict: ['pass','needs_attention','block','incomplete'].includes(run.verdict) ? run.verdict : 'unknown', coverageComplete: run.coverage_complete === 1, receiptState };
        if (!['valid', 'not_required_no_inference'].includes(receiptState)) reasons.add('review_receipt_invalid');
        if (run.coverage_complete !== 1 || !['pass', 'needs_attention'].includes(run.verdict) || job.status !== run.verdict) reasons.add('review_run_not_complete');
        const unsettled = Number(db.prepare("SELECT COUNT(*) count FROM publication_outbox WHERE run_id=? AND status<>'published'").get(run.id).count);
        if (unsettled) reasons.add('review_publication_not_complete');
        const outbox = db.prepare(`SELECT * FROM publication_outbox WHERE project_id=? AND mr_iid=? AND action_type IN ('status','cancel_status')
          AND (run_id=? OR (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.jobId') ELSE NULL END)=? OR dedupe_key LIKE ?)
          ORDER BY id DESC LIMIT 1`).get(projectId, mrIid, run.id, job.id, `job:${job.id}:status:%`);
        if (!outbox) reasons.add('final_status_missing');
        if (outbox) {
          result.generation.outboxId = outbox.id;
          result.publication = { state: ['pending','publishing','published','failed','cancelled','uncertain'].includes(outbox.status) ? outbox.status : 'unknown', acknowledged: false };
          const payload = parseObject(outbox.payload_json);
          const bound = outbox.run_id === run.id && outbox.action_type === 'status' && outbox.dedupe_key === `job:${job.id}:status:final` &&
            payload.jobId === job.id && payload.statusPublicationProtocol === 1 && payload.statusProjectId === identity.projectId &&
            payload.headSha === job.head_sha && payload.startSha === job.start_sha && payload.ref === identity.ref &&
            payload.statusName === identity.statusName && (payload.pipelineId ?? null) === job.pipeline_id && payload.state === 'success';
          if (!bound) reasons.add('final_status_identity_mismatch');
          if (outbox.status !== 'published') reasons.add('final_status_not_published');
          const target = db.prepare('SELECT * FROM status_publication_targets WHERE target_key=?').get(key);
          if (!target) reasons.add('status_target_missing');
          else {
            const storedIdentity = parseObject(target.identity_json), storedItem = parseObject(target.latest_item_json);
            if (!validIdentity(storedIdentity) || storedIdentity.scopeUnknown || identityKey(storedIdentity) !== key || target.latest_outbox_id !== outbox.id ||
              target.latest_job_id !== job.id || storedItem.id !== outbox.id || storedItem.run_id !== outbox.run_id ||
              storedItem.project_id !== projectId || storedItem.mr_iid !== mrIid || storedItem.action_type !== outbox.action_type ||
              storedItem.dedupe_key !== outbox.dedupe_key || fingerprint(storedItem.payload) !== fingerprint(payload)) reasons.add('status_target_generation_mismatch');
            if (target.projection_state !== 'published') reasons.add('status_target_not_published');
            const attempt = db.prepare('SELECT outcome,remote_id,job_id,payload_json FROM status_write_attempts WHERE target_key=? AND outbox_id=? ORDER BY id DESC LIMIT 1').get(key, outbox.id);
            const acknowledged = attempt?.outcome === 'acknowledged' && attempt.job_id === job.id && REMOTE_ID.test(attempt.remote_id) &&
              attempt.remote_id === outbox.remote_id && attempt.remote_id === target.latest_remote_id && fingerprint(parseObject(attempt.payload_json)) === fingerprint(payload);
            result.publication.acknowledged = acknowledged;
            if (!acknowledged) reasons.add('current_status_acknowledgement_missing');
          }
        }
      }
    }
  }
  result.reasons = [...reasons];
  if (!reasons.size) result.decision = 'evidence_complete_unbound';
  return result;
}

function readPublicationEvidence(dbPath, config, projectId, mrIid) {
  projectId = positiveId(projectId);
  mrIid = positiveId(mrIid);
  const identity = { apiUrl: config?.gitlabApiUrl, projectId: 1, headSha: 'a'.repeat(40), ref: 'identity-check', statusName: config?.statusName };
  if (!validIdentity(identity)) throw Object.assign(new Error('Publication identity configuration is invalid.'), { code: 'ECONFIGFILE' });
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');
    const result = inspectSnapshot(db, config, projectId, mrIid);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch {}
    if (error?.code === 'EDBSCHEMA') throw error;
    throw Object.assign(new Error('Publication evidence could not be read consistently.'), { code: 'EPUBLICATIONEVIDENCE' });
  } finally {
    db?.close();
  }
}

module.exports = { readPublicationEvidence, evidenceBase, positiveId };
