'use strict';

const { buildSnapshot, buildPrompt, validateReview, formatSummary } = require('./review');
const { runCodex } = require('./codex');

class ReviewService {
  constructor({ config, store, gitlab, logger = console }) {
    this.config = config;
    this.store = store;
    this.gitlab = gitlab;
    this.logger = logger;
    this.active = new Map();
    this.stopping = false;
  }

  key(projectId, iid) { return `${projectId}:${iid}`; }

  async enqueue(projectId, iid, trigger, dedupeKey) {
    const mr = await this.gitlab.getMergeRequest(projectId, iid);
    if (mr.state !== 'opened') return null;
    const headSha = String(mr.diff_refs?.head_sha || mr.sha || '').trim();
    const baseSha = String(mr.diff_refs?.base_sha || '').trim();
    if (!headSha) throw new Error('Merge request does not expose a head SHA');
    const active = this.active.get(this.key(projectId, iid));
    if (active && active.headSha !== headSha) active.controller.abort();
    return this.store.enqueue({
      projectId, mrIid: iid, baseSha, headSha, trigger,
      dedupeKey: dedupeKey || `head:${headSha}`
    });
  }

  async processJob(job) {
    const key = this.key(job.project_id, job.mr_iid);
    const controller = new AbortController();
    this.active.set(key, { headSha: job.head_sha, controller });
    const started = Date.now();
    try {
      const mr = await this.gitlab.getMergeRequest(job.project_id, job.mr_iid);
      const currentHead = String(mr.diff_refs?.head_sha || mr.sha || '');
      if (mr.state !== 'opened' || currentHead !== job.head_sha) {
        this.store.finishJob(job.id, 'superseded');
        return;
      }

      await this.gitlab.setCommitStatus(job.project_id, job.head_sha, 'running', 'Codex review is running');
      const diffs = await this.gitlab.listMergeRequestDiffs(job.project_id, job.mr_iid);
      const snapshot = buildSnapshot(mr, diffs, this.config.maxDiffBytes);
      const prompt = buildPrompt(snapshot, this.config);
      const { parsed, version } = await runCodex(prompt, this.config, controller.signal);
      const review = validateReview(parsed, snapshot, this.config);
      review.codexVersion = version;

      const latest = await this.gitlab.getMergeRequest(job.project_id, job.mr_iid);
      const latestHead = String(latest.diff_refs?.head_sha || latest.sha || '');
      if (controller.signal.aborted || latestHead !== job.head_sha) {
        this.store.finishJob(job.id, 'superseded');
        return;
      }

      const runId = this.store.saveRun(job.id, review, Date.now() - started);
      await this.publish(job, snapshot, review, runId);
      const status = review.verdict === 'block' ? 'blocked' : review.verdict;
      this.store.finishJob(job.id, status);
    } catch (error) {
      if (error.code === 'ESUPERSEDED' || controller.signal.aborted) {
        this.store.finishJob(job.id, 'superseded');
        return;
      }
      this.logger.error({ event: 'review_failed', jobId: job.id, projectId: job.project_id, mrIid: job.mr_iid, head: job.head_sha.slice(0, 12), code: error.code || 'EUNKNOWN' });
      this.store.finishJob(job.id, 'failed', error.code || 'EUNKNOWN');
      try { await this.gitlab.setCommitStatus(job.project_id, job.head_sha, 'failed', 'Codex review service failed'); } catch {}
    } finally {
      if (this.active.get(key)?.controller === controller) this.active.delete(key);
    }
  }

  async publish(job, snapshot, review, runId) {
    await this.gitlab.upsertSummary(job.project_id, job.mr_iid, formatSummary(review, snapshot));

    const previous = this.store.latestFindings(job.project_id, job.mr_iid, job.id);
    const previousByFingerprint = new Map();
    for (const old of previous) {
      if (!previousByFingerprint.has(old.fingerprint)) previousByFingerprint.set(old.fingerprint, old);
    }
    const currentFingerprints = new Set(review.findings.map(f => f.fingerprint));

    if (this.config.autoResolveObsolete) {
      for (const old of previousByFingerprint.values()) {
        if (old.discussion_id && !currentFingerprints.has(old.fingerprint)) {
          try { await this.gitlab.resolveDiscussion(job.project_id, job.mr_iid, old.discussion_id); } catch {}
        }
      }
    }

    const rows = this.store.findingsForRun(runId);
    for (const row of rows) {
      const prior = previousByFingerprint.get(row.fingerprint);
      if (prior?.discussion_id) {
        this.store.setDiscussionId(row.id, prior.discussion_id);
        continue;
      }
      const finding = review.findings.find(f => f.fingerprint === row.fingerprint);
      const file = snapshot.files.find(f => f.path === finding.file);
      try {
        const discussion = await this.gitlab.createDiscussion(
          job.project_id, job.mr_iid, finding, snapshot.diffRefs, file.old_path, file.new_path
        );
        this.store.setDiscussionId(row.id, discussion.id);
      } catch (error) {
        this.logger.warn?.({ event: 'inline_comment_failed', jobId: job.id, finding: finding.fingerprint.slice(0, 12), status: error.status || null });
      }
    }

    const state = (review.verdict === 'block' || review.verdict === 'incomplete') ? 'failed' : 'success';
    const description = review.verdict === 'pass' ? 'No substantive findings' :
      review.verdict === 'incomplete' ? 'Review coverage incomplete' : `${review.findings.length} finding(s)`;
    await this.gitlab.setCommitStatus(job.project_id, job.head_sha, state, description);
  }

  async workerLoop() {
    while (!this.stopping) {
      const job = this.store.claimNext();
      if (!job) {
        await new Promise(resolve => setTimeout(resolve, this.config.pollIntervalMs));
        continue;
      }
      await this.processJob(job);
    }
  }

  stop() {
    this.stopping = true;
    for (const active of this.active.values()) active.controller.abort();
  }
}

module.exports = { ReviewService };
