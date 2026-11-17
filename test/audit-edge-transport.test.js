'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { targetMap, readUpstream, createUpstreamReader, MAX_GET_BYTES } = require('../src/edge-transport');
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { host: '127.0.0.1', port: server.address().port };
}
test('fixed map rejects shared endpoints and hidden or unexpected target fields', () => {
  assert.throws(() => targetMap({ primary: {host:'127.0.0.1',port:8787}, sensor: {host:'127.0.0.1',port:8787} }, ['primary','sensor']), /share/);
  assert.throws(() => targetMap({ primary: {host:'primary',port:8787,token:'not-a-secret'} }, ['primary']), /fixed trusted/);
  assert.throws(() => targetMap(Object.create({primary:{host:'primary',port:8787}}), ['primary']), /fixed trusted/);
  assert.equal(targetMap({ primary: {host:'primary',port:8787}, sensor: {host:'sensor',port:8787} }, ['primary','sensor']).sensor.host, 'sensor');
});
test('read has an absolute deadline even when upstream continuously drips bytes', async t => {
  let closed;
  const closeObserved = new Promise(resolve => { closed = resolve; });
  const target = await listen(t, (req, res) => {
    res.writeHead(200); res.write('x');
    const timer = setInterval(() => res.write('x'), 10);
    res.on('close', () => { clearInterval(timer); closed(); });
  });
  const started = performance.now();
  const result = await readUpstream(target, '/metrics', 100);
  assert.deepEqual(result, {status:0,body:''});
  assert.ok(performance.now() - started < 2000, 'wall deadline must beat an indefinitely active socket');
  await closeObserved;
});
test('partial, oversized and invalid UTF-8 responses never become successful observations', async t => {
  const target = await listen(t, (req, res) => {
    if (req.url === '/metrics') { res.end(Buffer.alloc(MAX_GET_BYTES + 1)); return; }
    if (req.url === '/version') { res.end(Buffer.from([0xff])); return; }
    res.writeHead(200, {'Content-Length':'20'}); res.write('partial');
    setImmediate(() => res.destroy());
  });
  for (const path of ['/metrics','/version','/health/ready']) assert.equal((await readUpstream(target,path)).status, 0);
  assert.throws(() => readUpstream(target, '/untrusted'), /bounded/);
  assert.throws(() => readUpstream(target, '/metrics', Infinity), /bounded/);
});
test('concurrent observations coalesce, expire, and never reuse stale success after failure', async () => {
  const target = Object.freeze({host:'primary',port:8787});
  let calls = 0, clock = 0, status = 200;
  const read = createUpstreamReader({primary:target}, {ttlMs:100,now:()=>clock,read:async () => {
    calls++; await new Promise(resolve => setImmediate(resolve)); return {status,body:status===200?'observed':''};
  }});
  const result = await Promise.all(Array.from({length:40}, () => read(target,'/metrics')));
  assert.equal(calls, 1); assert.ok(result.every(value => value.status === 200));
  await read(target,'/metrics'); assert.equal(calls, 1);
  clock = 101; status = 503;
  assert.equal((await read(target,'/metrics')).status, 503); assert.equal(calls, 2);
  assert.equal((await read(target,'/metrics')).status, 503); assert.equal(calls, 3);
  status = 200; assert.equal((await read(target,'/metrics')).body, 'observed');
  await assert.rejects(read({...target},'/metrics'), /Unknown/);
});
