'use strict';

const crypto = require('node:crypto');

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function normalizeUrl(value) { try { return new URL(String(value)).toString().replace(/\/$/, ''); } catch { return ''; } }
function verifyInstance(headers, config) {
  const actual = String(headers['x-gitlab-instance'] || '').trim();
  if (!actual) return config.requireInstanceHeader ? { ok: false, reason: 'missing_instance' } : { ok: true };
  return normalizeUrl(actual) === normalizeUrl(config.webhookExpectedInstance) ? { ok: true } : { ok: false, reason: 'wrong_instance' };
}
function verifySignedWebhook(headers, rawBody, config, webhookId, nowMs) {
  const timestamp = String(headers['webhook-timestamp'] || '').trim();
  const signatures = String(headers['webhook-signature'] || '').trim();
  if (!timestamp || !signatures) return { ok: false, reason: 'missing_signature' };
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'invalid_timestamp' };
  if (Math.abs(nowMs - seconds * 1000) > config.webhookMaxSkewSeconds * 1000) return { ok: false, reason: 'stale_timestamp' };
  const rawKey = Buffer.from(config.webhookSigningToken.slice('whsec_'.length), 'base64');
  const digest = crypto.createHmac('sha256', rawKey).update(`${webhookId}.${timestamp}.${rawBody}`).digest('base64');
  const expected = `v1,${digest}`;
  return signatures.split(/\s+/).some(signature => safeEqual(expected, signature))
    ? { ok: true, webhookId, mode: 'hmac' } : { ok: false, reason: 'bad_signature' };
}
function verifyWebhook(headers, rawBody, config, nowMs = Date.now()) {
  const webhookId = String(headers['webhook-id'] || headers['idempotency-key'] || headers['x-gitlab-event-uuid'] || '').trim();
  if (!webhookId) return { ok: false, reason: 'missing_webhook_id' };
  if (webhookId.length > 255 || /[\r\n\0]/.test(webhookId)) return { ok: false, reason: 'invalid_webhook_id' };
  const instance = verifyInstance(headers, config); if (!instance.ok) return instance;
  if (config.webhookSigningToken && headers['webhook-signature']) return verifySignedWebhook(headers, rawBody, config, webhookId, nowMs);
  if (config.webhookSecretToken) {
    const token = String(headers['x-gitlab-token'] || '').trim();
    return safeEqual(token, config.webhookSecretToken) ? { ok: true, webhookId, mode: 'secret' } : { ok: false, reason: 'bad_secret' };
  }
  return { ok: false, reason: 'missing_signature' };
}
function normalizeEvent(payload, headers, config) {
  const event = String(headers['x-gitlab-event'] || payload.event_type || payload.object_kind || 'unknown');
  const projectId = Number(payload.project?.id || payload.project_id || 0) || null;
  const projectAllowed = projectId && (!config.gitlabProjectAllowlist || config.gitlabProjectAllowlist.has(projectId));
  if (payload.object_kind === 'merge_request') {
    const attrs = payload.object_attributes || {}; const iid = Number(attrs.iid || 0) || null; const action = String(attrs.action || '');
    const headSha = String(attrs.last_commit?.id || attrs.diff_refs?.head_sha || attrs.sha || '').trim();
    const baseSha = String(attrs.diff_refs?.base_sha || '').trim(); const startSha = String(attrs.diff_refs?.start_sha || '').trim();
    const sourceBranch = String(attrs.source_branch || '').trim();
    const codeUpdate = action === 'update' && typeof attrs.oldrev === 'string' && attrs.oldrev.length > 0;
    const shouldReview = projectAllowed && iid && ((action === 'open' && config.triggerOnOpen) || (action === 'reopen' && config.triggerOnReopen) || (codeUpdate && config.triggerOnPush));
    return { event, kind: 'merge_request', projectId, iid, action, headSha, baseSha, startSha, sourceBranch,
      shouldReview: Boolean(shouldReview), shouldCancel: Boolean(projectAllowed && iid && ['close', 'merge'].includes(action)), projectAllowed: Boolean(projectAllowed) };
  }
  if (payload.object_kind === 'note' && payload.merge_request) {
    const attrs = payload.object_attributes || {}; const author = String(payload.user?.username || '').trim();
    const userId = Number(payload.user?.id || attrs.author_id || 0) || null; const note = String(attrs.note || '').trim();
    const action = String(attrs.action || ''); const iid = Number(payload.merge_request?.iid || 0) || null;
    const command = action === 'create' && /^\/codex\s+review\s*$/i.test(note);
    const self = Boolean(config.botUsername) && author.toLowerCase() === config.botUsername.toLowerCase();
    return { event, kind: 'note', projectId, iid, author, userId, action, command,
      shouldReview: Boolean(projectAllowed && iid && userId && command && !self), shouldCancel: false, projectAllowed: Boolean(projectAllowed) };
  }
  return { event, kind: 'ignored', projectId, iid: null, shouldReview: false, shouldCancel: false, projectAllowed: Boolean(projectAllowed) };
}
module.exports = { verifyWebhook, normalizeEvent, safeEqual, verifyInstance, normalizeUrl };
