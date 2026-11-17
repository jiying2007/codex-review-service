'use strict';

// Bounded, credential-free reads of a fixed operator-supplied private map.
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const INSTANCE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_INSTANCES = 16, MAX_GET_BYTES = 256 * 1024, UPSTREAM_TIMEOUT = 2000;
const READ_PATHS = new Set(['/health/live', '/health/ready', '/health/dependencies', '/metrics', '/version']);
function targetMap(targets, instanceIds) {
  if (!Array.isArray(instanceIds) || instanceIds.length < 1 || instanceIds.length > MAX_INSTANCES ||
      instanceIds.some(id => typeof id !== 'string' || !INSTANCE_ID.test(id)) ||
      new Set(instanceIds).size !== instanceIds.length) throw new TypeError('Invalid configured upstream instance IDs');
  if (!targets || typeof targets !== 'object' || Array.isArray(targets))
    throw new TypeError('Sharded edge requires a trusted fixed target map');
  const result = {}, endpoints = new Set();
  for (const id of instanceIds) {
    const target = Object.hasOwn(targets, id) ? targets[id] : null;
    if (!target || typeof target !== 'object' || Array.isArray(target) ||
        Object.keys(target).some(key => !['host', 'port'].includes(key)) ||
        !['127.0.0.1', id].includes(target.host) ||
        !Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65535)
      throw new TypeError('Sharded edge requires a fixed trusted per-instance upstream');
    const endpoint = target.host + ':' + target.port;
    if (endpoints.has(endpoint)) throw new TypeError('Different GitLab instances must not share an upstream endpoint');
    endpoints.add(endpoint);
    result[id] = Object.freeze({ host: target.host, port: target.port });
  }
  if (Object.keys(targets).length !== instanceIds.length)
    throw new TypeError('Sharded edge refuses additional dynamic upstream hosts');
  return Object.freeze(result);
}
function readUpstream(target, path, timeoutMs = UPSTREAM_TIMEOUT) {
  if (!READ_PATHS.has(path) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new TypeError('Invalid bounded upstream read');
  return new Promise(resolve => {
    let done = false, req, deadline;
    const finish = (status, body = '') => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      resolve({ status, body });
    };
    const abort = () => { finish(0); req?.destroy(); };
    // Socket inactivity alone is insufficient: a peer can drip bytes forever.
    // This wall-clock deadline also includes DNS/connect/header/body time.
    deadline = setTimeout(abort, timeoutMs);
    deadline.unref?.();
    try {
      req = http.get({ hostname: target.host, port: target.port, path, timeout: timeoutMs }, res => {
        let bytes = 0;
        const chunks = [];
        res.on('data', chunk => {
          if (done) return;
          bytes += chunk.length;
          if (bytes > MAX_GET_BYTES) { abort(); return; }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (done) return;
          try {
            if (!res.complete) { abort(); return; }
            finish(res.statusCode || 0, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          } catch { abort(); }
        });
        res.on('aborted', abort);
        res.on('error', abort);
      });
      req.on('timeout', abort);
      req.on('error', abort);
    } catch { abort(); }
  });
}
function createUpstreamReader(targets, { ttlMs = 1000, read = readUpstream, now = () => performance.now() } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || ttlMs > 3000) throw new TypeError('Invalid observation cache lifetime');
  const caches = new Map(Object.values(targets).map(target => [target, new Map()]));
  return function observe(target, path) {
    const cache = caches.get(target);
    if (!cache || !READ_PATHS.has(path)) return Promise.reject(new TypeError('Unknown fixed upstream read'));
    const previous = cache.get(path), at = now();
    if (previous?.pending) return previous.pending;
    if (previous?.value && at < previous.expiresAt) return Promise.resolve(previous.value);
    const entry = { pending: null, value: null, expiresAt: -Infinity };
    cache.set(path, entry);
    entry.pending = Promise.resolve().then(() => read(target, path)).then(value => {
      entry.pending = null;
      // Never serve a stale success after a failed refresh. Failures coalesce
      // only while in flight and are not cached as a successful observation.
      if (value.status === 200) {
        entry.value = Object.freeze({ status: value.status, body: value.body });
        entry.expiresAt = now() + ttlMs;
      }
      return value;
    }, error => { cache.delete(path); throw error; });
    return entry.pending;
  };
}
module.exports = { targetMap, readUpstream, createUpstreamReader, MAX_GET_BYTES };
