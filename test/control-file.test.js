'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readControlJson } = require('../src/control-file');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-control-file-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'control.json');
  fs.writeFileSync(file, '{"value":"checked"}', { mode: 0o600 });
  return { dir, file };
}

test('bounded control reader retains readable deployment files owned by another UID', t => {
  const { file } = fixture(t);
  const fsImpl = Object.create(fs);
  fsImpl.fstatSync = fd => {
    const stat = fs.fstatSync(fd);
    stat.uid = Number(process.getuid?.() || 0) + 1;
    return stat;
  };
  assert.deepEqual(readControlJson(file, { fsImpl }), { value: 'checked' });
});

test('control reader rejects replacement during descriptor reading and closes the descriptor', t => {
  const { file, dir } = fixture(t);
  const fsImpl = Object.create(fs);
  let replaced = false, closed = 0;
  fsImpl.readSync = (...args) => {
    const count = fs.readSync(...args);
    if (!replaced) {
      replaced = true;
      fs.renameSync(file, path.join(dir, 'original.json'));
      fs.writeFileSync(file, '{"value":"replacement"}', { mode: 0o600 });
    }
    return count;
  };
  fsImpl.closeSync = fd => { closed++; return fs.closeSync(fd); };
  assert.throws(() => readControlJson(file, { fsImpl }), { code: 'ELOCALFILE' });
  assert.equal(replaced, true);
  assert.equal(closed, 1);
});

(process.platform === 'win32' ? test.skip : test)('release and tenant admission reject a real FIFO without waiting for a writer', t => {
  const { dir } = fixture(t);
  const fifo = path.join(dir, 'control.fifo');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 3000, shell: false });
  assert.ifError(made.error);
  assert.equal(made.status, 0, made.stderr);
  // Keep a bounded OS process around the real readers: a regression must fail
  // promptly instead of hanging the test runner on open(O_RDONLY).
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { readIntent } = require('./scripts/release-integrity-admission');
    const { loadMultiManifest } = require('./src/multi-gitlab-config');
    assert.throws(() => readIntent(process.argv[1]), { code: 'ERELEASEINTENT' });
    assert.throws(() => loadMultiManifest(process.argv[1]), { code: 'EMULTIGITLABCONFIG' });
  `, fifo], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 3000,
    maxBuffer: 64 * 1024, shell: false
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
