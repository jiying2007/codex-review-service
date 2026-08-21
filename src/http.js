'use strict';

const http = require('node:http');
const { verifyWebhook, normalizeEvent } = require('./webhook');

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const error = Object.assign(new Error('Webhook body too large'), { status: 413 });
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createHttpServer({ config, store, service, gitlab, logger = console }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/health/live') {
        return json(res, 200, { status: 'ok' });
      }
      if (req.method === 'GET' && url.pathname === '/health/ready') {
        let gitlabOk = false;
        try {
          await fetch(`${config.gitlabApiUrl}/version`, {
            headers: { 'PRIVATE-TOKEN': config.gitlabToken },
            signal: AbortSignal.timeout(3000)
          }).then(response => { gitlabOk = response.ok; });
        } catch {}
        const ready = gitlabOk && !service.stopping;
        return json(res, ready ? 200 : 503, {
          status: ready ? 'ready' : 'not_ready',
          gitlab: gitlabOk,
          worker: !service.stopping,
          queueDepth: store.queueDepth()
        });
      }
      if (req.method === 'GET' && url.pathname === '/metrics') {
        const body = `# TYPE codex_review_queue_depth gauge\ncodex_review_queue_depth ${store.queueDepth()}\n`;
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' });
        return res.end(body);
      }
      if (req.method !== 'POST' || url.pathname !== '/webhooks/gitlab') {
        return json(res, 404, { error: 'not_found' });
      }

      const rawBody = await readBody(req, config.webhookMaxBodyBytes);
      const verification = verifyWebhook(req.headers, rawBody, config);
      if (!verification.ok) {
        logger.warn?.({ event: 'webhook_rejected', reason: verification.reason });
        return json(res, 401, { error: 'unauthorized' });
      }

      let payload;
      try { payload = JSON.parse(rawBody); }
      catch { return json(res, 400, { error: 'invalid_json' }); }
      const event = normalizeEvent(payload, req.headers, config);
      const fresh = store.recordWebhook({
        webhookId: verification.webhookId,
        eventType: event.event,
        projectId: event.projectId,
        mrIid: event.iid
      });
      if (!fresh) return json(res, 200, { status: 'duplicate' });

      if (event.shouldReview) {
        await service.enqueue(event.projectId, event.iid, event.kind === 'note' ? 'command' : event.action);
      }
      store.markWebhookProcessed(verification.webhookId);
      return json(res, 202, { status: event.shouldReview ? 'queued' : 'ignored' });
    } catch (error) {
      logger.error({ event: 'http_error', code: error.code || 'EHTTP', status: error.status || 500 });
      if (!res.headersSent) return json(res, error.status || 500, { error: 'internal_error' });
      res.destroy();
    }
  });
}

module.exports = { createHttpServer, readBody };
