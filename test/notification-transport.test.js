'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { postJson, WebhookProvider, FeishuAppProvider, Notifier } = require('../src/notification');

async function localServer(t, handler) {
  const errors = [];
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(error => {
      errors.push(error);
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.deepEqual(errors, []);
  });
  return 'http://127.0.0.1:' + server.address().port;
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function json(response, value, status = 200, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(value));
}

const event = {
  type: 'service.degraded',
  occurredAt: '2026-10-25T00:00:00.000Z',
  verdict: 'degraded',
  findingCounts: {},
  topFindings: [],
};

test('notification POST and PATCH never forward a body to a redirect target', async t => {
  const received = [];
  const forwarded = [];
  const target = await localServer(t, async (request, response) => {
    forwarded.push(await requestBody(request));
    json(response, { code: 0 });
  });
  let status = 307;
  const origin = await localServer(t, async (request, response) => {
    received.push({ method: request.method, body: await requestBody(request) });
    json(response, {}, status, { location: target + '/collect' });
  });
  const payload = { app_secret: 'local-test-secret', diagnostic: 'local-test-review-content' };
  for (const method of ['POST', 'PATCH']) {
    for (const redirect of [301, 302, 303, 307, 308]) {
      status = redirect;
      await assert.rejects(
        () => postJson(origin + '/send', payload, 2000, { method }),
        error => error.code === 'ENOTIFYHTTP' && error.status === redirect && error.retryable === false,
      );
    }
  }
  assert.equal(received.length, 10);
  assert.ok(received.every(item => item.body === JSON.stringify(payload)));
  assert.deepEqual(forwarded, []);
});

test('normal notification writes reach their destination once with the original body', async t => {
  const received = [];
  const origin = await localServer(t, async (request, response) => {
    received.push({ method: request.method, body: await requestBody(request) });
    json(response, { code: 0 });
  });
  for (const method of ['POST', 'PATCH']) {
    const payload = { message: 'normal-local-delivery', method };
    assert.deepEqual(await postJson(origin + '/send', payload, 2000, { method }), { code: 0 });
    assert.deepEqual(received.at(-1), { method, body: JSON.stringify(payload) });
  }
  assert.equal(received.length, 2);
});

test('Feishu token, message and update requests stop before a redirect target', async t => {
  const received = [];
  const forwarded = [];
  const target = await localServer(t, async (request, response) => {
    forwarded.push(await requestBody(request));
    json(response, { code: 0, tenant_access_token: 'redirected-token', data: { message_id: 'om_redirected' } });
  });
  const origin = await localServer(t, async (request, response) => {
    received.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: JSON.parse(await requestBody(request)) });
    json(response, {}, 307, { location: target + '/collect' });
  });
  const env = {
    CODEX_REVIEW_NOTIFY_TEAM_APP_ID: 'cli_localtest',
    CODEX_REVIEW_NOTIFY_TEAM_APP_SECRET: 'local-test-app-secret',
    CODEX_REVIEW_NOTIFY_TEAM_CHAT_ID: 'oc_localtest',
  };
  // Preserve production URL/credential validation; only the test transport maps to loopback.
  const provider = new FeishuAppProvider({
    env,
    fetchImpl: (url, options) => fetch(origin + new URL(url).pathname, options),
  });
  const route = { name: 'team', provider: 'feishu_app', secretRef: 'team' };
  const credentials = { appId: 'cli_localtest', appSecret: 'local-test-app-secret', chatId: 'oc_localtest' };
  for (const operation of [
    () => provider.tenantAccessToken(route, 2000),
    () => provider.sendWithToken(credentials, 'local-test-tenant-token', event, 2000),
    () => provider.updateWithToken(credentials, 'local-test-tenant-token', 'om_localtest', event, 2000),
  ]) {
    await assert.rejects(operation, error => error.code === 'ENOTIFYHTTP' && error.status === 307);
  }
  assert.equal(received.length, 3);
  assert.equal(received[0].body.app_secret, 'local-test-app-secret');
  assert.equal(received[1].authorization, 'Bearer local-test-tenant-token');
  assert.equal(received[2].method, 'PATCH');
  assert.deepEqual(forwarded, []);
});

test('webhook providers require their explicit numeric success acknowledgements over real HTTP', async t => {
  let current;
  const received = [];
  const origin = await localServer(t, async (request, response) => {
    received.push(JSON.parse(await requestBody(request)));
    if (Object.hasOwn(current, 'raw')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(current.raw);
    } else {
      json(response, current.body);
    }
  });
  const cases = [
    { name: 'Feishu code zero', provider: 'feishu', body: { code: 0 } },
    { name: 'Feishu legacy zero', provider: 'feishu', body: { StatusCode: 0 } },
    { name: 'Feishu agreeing codes', provider: 'feishu', body: { code: 0, StatusCode: 0 } },
    { name: 'WeCom errcode zero', provider: 'wecom', body: { errcode: 0 } },
    { name: 'Feishu remote error', provider: 'feishu', body: { code: 19021 }, error: 'ENOTIFYREMOTE' },
    { name: 'WeCom remote error', provider: 'wecom', body: { errcode: 45009 }, error: 'ENOTIFYREMOTE' },
    { name: 'Feishu missing acknowledgement', provider: 'feishu', body: {}, error: 'ENOTIFYPROTOCOL' },
    { name: 'WeCom missing acknowledgement', provider: 'wecom', body: {}, error: 'ENOTIFYPROTOCOL' },
    { name: 'Feishu cannot use WeCom acknowledgement', provider: 'feishu', body: { errcode: 0 }, error: 'ENOTIFYPROTOCOL' },
    { name: 'WeCom cannot use Feishu acknowledgement', provider: 'wecom', body: { code: 0 }, error: 'ENOTIFYPROTOCOL' },
    { name: 'WeCom cannot use legacy Feishu acknowledgement', provider: 'wecom', body: { StatusCode: 0 }, error: 'ENOTIFYPROTOCOL' },
    { name: 'Feishu string zero', provider: 'feishu', body: { code: '0' }, error: 'ENOTIFYPROTOCOL' },
    { name: 'WeCom string zero', provider: 'wecom', body: { errcode: '0' }, error: 'ENOTIFYPROTOCOL' },
    { name: 'legacy string zero', provider: 'feishu', body: { StatusCode: '0' }, error: 'ENOTIFYPROTOCOL' },
    { name: 'null code', provider: 'feishu', body: { code: null }, error: 'ENOTIFYPROTOCOL' },
    { name: 'boolean code', provider: 'wecom', body: { errcode: false }, error: 'ENOTIFYPROTOCOL' },
    { name: 'empty code', provider: 'feishu', body: { code: '' }, error: 'ENOTIFYPROTOCOL' },
    { name: 'array code', provider: 'wecom', body: { errcode: [] }, error: 'ENOTIFYPROTOCOL' },
    { name: 'success with legacy failure', provider: 'feishu', body: { code: 0, StatusCode: 1 }, error: 'ENOTIFYREMOTE' },
    { name: 'legacy success with modern failure', provider: 'feishu', body: { code: 1, StatusCode: 0 }, error: 'ENOTIFYREMOTE' },
    { name: 'Feishu success with other failure', provider: 'feishu', body: { code: 0, errcode: 1 }, error: 'ENOTIFYREMOTE' },
    { name: 'WeCom success with other failure', provider: 'wecom', body: { errcode: 0, code: 1 }, error: 'ENOTIFYREMOTE' },
    { name: 'success with malformed second code', provider: 'feishu', body: { code: 0, StatusCode: null }, error: 'ENOTIFYPROTOCOL' },
    { name: 'null response', provider: 'feishu', body: null, error: 'ENOTIFYPROTOCOL' },
    { name: 'array response', provider: 'wecom', body: [], error: 'ENOTIFYPROTOCOL' },
    { name: 'scalar response', provider: 'feishu', body: 0, error: 'ENOTIFYPROTOCOL' },
    { name: 'invalid JSON', provider: 'feishu', raw: '{invalid-json', error: 'ENOTIFYPROTOCOL' },
    { name: 'empty response', provider: 'wecom', raw: '', error: 'ENOTIFYPROTOCOL' },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      current = item;
      const route = { name: 'team', provider: item.provider, secretRef: 'team' };
      const url = item.provider === 'feishu'
        ? 'https://open.feishu.cn/open-apis/bot/v2/hook/local-test'
        : 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=local-test';
      const provider = new WebhookProvider({
        env: { CODEX_REVIEW_NOTIFY_TEAM_WEBHOOK: url },
        fetchImpl: (requested, options) => {
          assert.equal(requested, url);
          return fetch(origin + '/webhook', options);
        },
      });
      if (item.error) {
        await assert.rejects(() => provider.send(route, event, 2000), error => error.code === item.error && error.retryable === false);
      } else {
        const result = await provider.send(route, event, 2000);
        assert.equal(result.remoteId, item.provider + ':team');
        assert.deepEqual(result.body, item.body);
      }
    });
  }
  assert.equal(received.length, cases.length);
  assert.equal(received[0].msg_type, 'interactive');
  assert.equal(received[3].msgtype, 'template_card');
});

test('HTTP 200 without an acknowledgement cannot mark an outbox notification delivered', async t => {
  const origin = await localServer(t, async (request, response) => {
    await requestBody(request);
    json(response, {});
  });
  const finished = [];
  const failed = [];
  const notifier = new Notifier({
    config: {
      notificationRoutesResolved: [{ name: 'team', provider: 'feishu', secretRef: 'team' }],
      notificationRequestTimeoutMs: 2000,
      maxNotificationAttempts: 3,
    },
    env: { CODEX_REVIEW_NOTIFY_TEAM_WEBHOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/local-test' },
    store: {
      finishNotification(...args) { finished.push(args); },
      failNotification(...args) { failed.push(args); },
      retryNotification() { assert.fail('A malformed acknowledgement is not a retryable acceptance'); },
    },
    logger: { info() {}, warn() {} },
    fetchImpl: (url, options) => fetch(origin + '/webhook', options),
  });
  await notifier.process({ id: 7, route_name: 'team', provider: 'feishu', event_type: event.type, attempt: 1, payload: event });
  assert.deepEqual(finished, []);
  assert.deepEqual(failed, [[7, 'ENOTIFYPROTOCOL']]);
});
