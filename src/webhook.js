'use strict';

const crypto = require('node:crypto');

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function verifySignedWebhook(headers, rawBody, config, webhookId, nowMs) {
  const timestamp = String(headers['webhook-timestamp'] || '').trim();
  const signatures = String(headers['webhook-signature'] || '').trim();
  if (!timestamp || !signatures) return { ok: false, reason: 'missing_signature' };
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'invalid_timestamp' };
  if (Math.abs(nowMs - seconds * 1000) > config.webhookMaxSkewSeconds * 1000) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  let rawKey;
  try {
    const encoded = config.webhookSigningToken.replace(/^whsec_/, '');
    rawKey = Buffer.from(encoded, 'base64');
    if (!rawKey.length) throw new Error('empty key');
  } catch {
    return { ok: false, reason: 'invalid_signing_token' };
  }
  const message = `${webhookId}.${timestamp}.${rawBody}`;
  const digest = crypto.createHmac('sha256', rawKey).update(message).digest('base64');
  const expected = `v1,${digest}`;
  const matched = signatures.split(/\s+/).some(signature => safeEqual(expected, signature));
  return matched ? { ok: true, webhookId, mode: 'hmac' } : { ok: false, reason: 'bad_signature' };
}

function verifyWebhook(headers, rawBody, config, nowMs = Date.now()) {
  const webhookId = String(
    headers['webhook-id'] || headers['idempotency-key'] || headers['x-gitlab-event-uuid'] || ''
  ).trim();
  if (!webhookId) return { ok: false, reason: 'missing_webhook_id' };

  if (config.webhookSigningToken && headers['webhook-signature']) {
    return verifySignedWebhook(headers, rawBody, config, webhookId, nowMs);
  }
  if (config.webhookSecretToken) {
    const token = String(headers['x-gitlab-token'] || '').trim();
    return safeEqual(token, config.webhookSecretToken)
      ? { ok: true, webhookId, mode: 'secret' }
      : { ok: false, reason: 'bad_secret' };
  }
  return { ok: false, reason: 'missing_signature' };
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
    return { event, kind: 'merge_request', projectId, iid, action, headSha, baseSha, shouldReview: Boolean(projectId && iid && allowed) };
  }

  if (payload.object_kind === 'note' && payload.merge_request) {
    const author = String(payload.user?.username || '').trim();
    const note = String(payload.object_attributes?.note || '').trim();
    const iid = Number(payload.merge_request?.iid || 0) || null;
    const command = /^\/codex\s+review\s*$/i.test(note);
    const self = Boolean(config.botUsername) && author.toLowerCase() === config.botUsername.toLowerCase();
    return { event, kind: 'note', projectId, iid, author, command, shouldReview: Boolean(projectId && iid && command && !self) };
  }

  return { event, kind: 'ignored', projectId, iid: null, shouldReview: false };
}

module.exports = { verifyWebhook, normalizeEvent };
