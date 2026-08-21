'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyWebhook, normalizeEvent } = require('../src/webhook');

function baseConfig() {
  return {
    webhookSigningToken: '', webhookSecretToken: '', webhookMaxSkewSeconds: 300,
    botUsername: 'codex-review-bot', triggerOnOpen: true, triggerOnPush: true, triggerOnReopen: true
  };
}

test('verifies GitLab Standard Webhooks signature', () => {
  const key = crypto.randomBytes(32);
  const token = `whsec_${key.toString('base64')}`;
  const body = JSON.stringify({ object_kind: 'merge_request' });
  const id = 'message-123';
  const timestamp = '1755788400';
  const expected = 'v1,' + crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  const config = { ...baseConfig(), webhookSigningToken: token };
  const result = verifyWebhook({
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': expected
  }, body, config, Number(timestamp) * 1000);
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'hmac');
});

test('rejects stale signed webhook', () => {
  const key = crypto.randomBytes(32);
  const token = `whsec_${key.toString('base64')}`;
  const body = '{}';
  const id = 'message-123';
  const timestamp = '100';
  const signature = 'v1,' + crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  const result = verifyWebhook({ 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature }, body,
    { ...baseConfig(), webhookSigningToken: token }, 1000000);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale_timestamp');
});

test('supports legacy secret fallback', () => {
  const result = verifyWebhook({ 'x-gitlab-event-uuid': 'uuid', 'x-gitlab-token': 'secret' }, '{}',
    { ...baseConfig(), webhookSecretToken: 'secret' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'secret');
});

test('routes merge request and manual review command', () => {
  const config = baseConfig();
  const mr = normalizeEvent({
    object_kind: 'merge_request', project: { id: 7 },
    object_attributes: { iid: 9, action: 'open', last_commit: { id: 'abc' } }
  }, { 'x-gitlab-event': 'Merge Request Hook' }, config);
  assert.equal(mr.shouldReview, true);
  assert.equal(mr.projectId, 7);
  assert.equal(mr.iid, 9);

  const note = normalizeEvent({
    object_kind: 'note', project: { id: 7 }, user: { username: 'alice' },
    merge_request: { iid: 9 }, object_attributes: { note: '/codex review' }
  }, { 'x-gitlab-event': 'Note Hook' }, config);
  assert.equal(note.shouldReview, true);

  const self = normalizeEvent({
    object_kind: 'note', project: { id: 7 }, user: { username: 'codex-review-bot' },
    merge_request: { iid: 9 }, object_attributes: { note: '/codex review' }
  }, {}, config);
  assert.equal(self.shouldReview, false);
});
