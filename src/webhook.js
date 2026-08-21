'use strict';

const crypto = require('node:crypto');

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function verifyWebhook(headers, rawBody, config, nowMs = Date.now()) {
  const webhookId = String(headers['webhook-id'] || headers['x-gitlab-event-uuid'] || '').trim();
  if (!webhookId) return { ok: false, reason: 'missing_webhook_id' };

  if (config.webhookSigningToken) {
    const timestamp = String(headers['webhook-timestamp'] || '').trim();
    const signature = String(headers['webhook-signature'] || '').trim();
    if (!timestamp || !signature) return { ok: false, reason: 'missing_signature' };
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return { ok: false, reason: 'invalid_timestamp' };
    if (Math.abs(nowMs - seconds * 1000) > config.webhookMaxSkewSeconds * 1000) {
      return { ok: false, reason: 'stale_timestamp' };
    }
    const signed = `${webhookId}.${timestamp}.${rawBody}`;
    const expected = crypto.createHmac('sha256', config.webhookSigningToken).update(signed).digest('hex');
    const normalized = signature.replace(/^sha256=/i, '');
    if (!safeEqual(expected, normalized)) return { ok: false, reason: 'bad_signature' };
    return { ok: true, webhookId, mode: 'hmac' };
  }

  const token = String(headers['x-gitlab-token'] || '').trim();
  if (!safeEqual(token, config.webhookSecretToken)) return { ok: false, reason: 'bad_secret' };
  return { ok: true, webhookId, mode: 'secret' };
}

function normalizeEvent(payload, headers, config) {
  const event = String(headers['x-gitlab-event'] || payload.object_kind || 'unknown');
  const projectId = Number(payload.project?.id || payload.project_id || 0) || null;

  if (payload.object_kind === 'merge_request') {
    const attrs = payload.object_attributes || {};
    const iid = Number(attrs.iid || 0) || null;
    const action = String(attrs.action || '');
    const headSha = String(attrs.last_commit?.id || attrs.diff_refs?.head_sha || attrs.sha || '').trim();
    const baseSha = String(attrs.diff_refs?.base_sha || '').trim();
    const allowed = (action === 'open' && config.triggerOnOpen) ||
      (action === 'reopen' && config.triggerOnReopen) ||
      (action === 'update' && config.triggerOnPush && Boolean(headSha));
    return { event, kind: 'merge_request', projectId, iid, action, headSha, baseSha, shouldReview: allowed };
  }

  if (payload.object_kind === 'note' && payload.merge_request) {
    const author = String(payload.user?.username || '').trim();
    const note = String(payload.object_attributes?.note || '').trim();
    const iid = Number(payload.merge_request?.iid || 0) || null;
    const command = /^\/codex\s+review\s*$/i.test(note);
    const self = config.botUsername && author.toLowerCase() === config.botUsername.toLowerCase();
    return { event, kind: 'note', projectId, iid, author, command, shouldReview: command && !self };
  }

  return { event, kind: 'ignored', projectId, iid: null, shouldReview: false };
}

module.exports = { verifyWebhook, normalizeEvent };
