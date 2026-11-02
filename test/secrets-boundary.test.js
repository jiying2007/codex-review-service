'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readSecretFile } = require('../src/secrets');

const LIMIT = 64 * 1024;
const NAME = 'GITLAB_API_TOKEN';

function secret(t, value = 'original-secret') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-secret-boundary-'));
  const file = path.join(dir, 'secret');
  fs.writeFileSync(file, value, { mode: 0o600 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file };
}

function trackedFs() {
  const state = { opened: [], closed: [], bytes: 0 };
  const impl = {
    ...fs,
    openSync(...args) {
      const fd = fs.openSync(...args);
      state.opened.push(fd);
      return fd;
    },
    readSync(...args) {
      const count = fs.readSync(...args);
      state.bytes += count;
      return count;
    },
    closeSync(fd) {
      state.closed.push(fd);
      return fs.closeSync(fd);
    },
  };
  return { impl, state };
}

function assertClosed(state) {
  assert.equal(state.opened.length, 1);
  assert.deepEqual(state.closed, state.opened);
  assert.throws(() => fs.fstatSync(state.opened[0]), { code: 'EBADF' });
}

test('secret files accept the exact byte ceiling and reject larger files before reading', t => {
  const fixture = secret(t, 'a'.repeat(LIMIT));
  const accepted = trackedFs();
  assert.equal(readSecretFile(fixture.file, NAME, accepted.impl), 'a'.repeat(LIMIT));
  assertClosed(accepted.state);
  fs.writeFileSync(fixture.file, '界'.repeat(21846));
  const rejected = trackedFs();
  assert.throws(() => readSecretFile(fixture.file, NAME, rejected.impl), /64 KiB/);
  assert.equal(rejected.state.bytes, 0);
  assertClosed(rejected.state);
});

test('secret files preserve empty, multiline, NUL and absolute-path validation', t => {
  const fixture = secret(t);
  for (const value of ['', ' \r\n\t ', 'first\nsecond', 'token\0suffix']) {
    fs.writeFileSync(fixture.file, value);
    const recorded = trackedFs();
    assert.throws(() => readSecretFile(fixture.file, NAME, recorded.impl), /empty|invalid/);
    assertClosed(recorded.state);
  }
  assert.throws(() => readSecretFile('relative', NAME), /absolute path/);
  assert.throws(() => readSecretFile(path.join(fixture.dir, 'missing'), NAME), /cannot be read/);
});

test('replacing the checked pathname cannot retarget an opened secret file', t => {
  const fixture = secret(t);
  const recorded = trackedFs();
  let replaced = false;
  const replaceAfterCheck = stat => {
    if (!replaced) {
      replaced = true;
      fs.renameSync(fixture.file, path.join(fixture.dir, 'retired-secret'));
      fs.writeFileSync(fixture.file, 'replacement-secret');
    }
    return stat;
  };
  recorded.impl.fstatSync = fd => replaceAfterCheck(fs.fstatSync(fd));
  recorded.impl.statSync = file => replaceAfterCheck(fs.statSync(file));
  assert.equal(readSecretFile(fixture.file, NAME, recorded.impl), 'original-secret');
  assert.equal(fs.readFileSync(fixture.file, 'utf8'), 'replacement-secret');
  assert.equal(replaced, true);
  assertClosed(recorded.state);
});

test('mounted secret symlinks resolve once even if the symlink is replaced after opening', t => {
  const fixture = secret(t);
  const link = path.join(fixture.dir, 'mounted-secret');
  const replacement = path.join(fixture.dir, 'replacement');
  fs.writeFileSync(replacement, 'different-secret');
  fs.symlinkSync('secret', link, 'file');
  const recorded = trackedFs();
  let replaced = false;
  const replaceAfterCheck = stat => {
    if (!replaced) {
      replaced = true;
      fs.unlinkSync(link);
      fs.symlinkSync('replacement', link, 'file');
    }
    return stat;
  };
  recorded.impl.fstatSync = fd => replaceAfterCheck(fs.fstatSync(fd));
  recorded.impl.statSync = file => replaceAfterCheck(fs.statSync(file));
  assert.equal(readSecretFile(link, NAME, recorded.impl), 'original-secret');
  assert.equal(fs.readFileSync(link, 'utf8'), 'different-secret');
  assertClosed(recorded.state);
});

test('secret growth after fstat cannot exceed the bounded read ceiling', t => {
  const fixture = secret(t, 'small');
  const recorded = trackedFs();
  let grown = false;
  recorded.impl.fstatSync = fd => {
    const stat = fs.fstatSync(fd);
    if (!grown) {
      grown = true;
      fs.appendFileSync(fixture.file, 'x'.repeat(LIMIT * 2));
    }
    return stat;
  };
  assert.throws(() => readSecretFile(fixture.file, NAME, recorded.impl), /64 KiB/);
  assert.equal(recorded.state.bytes, LIMIT + 1);
  assertClosed(recorded.state);
});

test('growth during short reads cannot turn the secret read into an unbounded allocation', t => {
  const fixture = secret(t, 'small');
  const recorded = trackedFs();
  let grown = false;
  recorded.impl.readSync = (fd, buffer, offset, length, position) => {
    const count = fs.readSync(fd, buffer, offset, Math.min(length, 4096), position);
    recorded.state.bytes += count;
    if (!grown) {
      grown = true;
      fs.appendFileSync(fixture.file, 'x'.repeat(LIMIT * 2));
    }
    return count;
  };
  assert.throws(() => readSecretFile(fixture.file, NAME, recorded.impl), /64 KiB/);
  assert.equal(recorded.state.bytes, LIMIT + 1);
  assertClosed(recorded.state);
});

test('growth after the last EOF read is still checked on the opened descriptor', t => {
  const fixture = secret(t, 'small');
  const recorded = trackedFs();
  let grown = false;
  recorded.impl.readSync = (...args) => {
    const count = fs.readSync(...args);
    recorded.state.bytes += count;
    if (count === 0 && !grown) {
      grown = true;
      fs.appendFileSync(fixture.file, 'x'.repeat(LIMIT));
    }
    return count;
  };
  assert.throws(() => readSecretFile(fixture.file, NAME, recorded.impl), /64 KiB/);
  assert.equal(grown, true);
  assertClosed(recorded.state);
});

test('secret descriptors close when fstat or a read fails', t => {
  const fixture = secret(t);
  for (const operation of ['fstatSync', 'readSync']) {
    const recorded = trackedFs();
    const failure = Object.assign(new Error('injected I/O failure'), { code: 'EIO' });
    recorded.impl[operation] = () => { throw failure; };
    assert.throws(() => readSecretFile(fixture.file, NAME, recorded.impl), error => error === failure || error.cause === failure);
    assertClosed(recorded.state);
  }
});

test('secret files reject directories and native special files without waiting for data', t => {
  const fixture = secret(t);
  assert.throws(() => readSecretFile(fixture.dir, NAME), /regular file|cannot be read/);
  let special;
  if (process.platform === 'win32') {
    special = '\\\\.\\NUL';
  } else {
    special = path.join(fixture.dir, 'secret-fifo');
    const created = spawnSync('mkfifo', [special], { encoding: 'utf8', timeout: 3000 });
    assert.ifError(created.error);
    assert.equal(created.status, 0, created.stderr);
    assert.throws(() => readSecretFile('/dev/null', NAME), /regular file/);
  }
  const result = spawnSync(process.execPath, [
    '-e',
    "const assert=require('node:assert/strict');const{readSecretFile}=require(process.argv[1]);assert.throws(()=>readSecretFile(process.argv[2],'GITLAB_API_TOKEN'),/regular file|cannot be read/);",
    require.resolve('../src/secrets'),
    special,
  ], { encoding: 'utf8', timeout: 3000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('readable Docker and group-readable secret modes remain supported', t => {
  const fixture = secret(t, 'mounted-secret\n');
  for (const mode of [0o444, 0o640]) {
    fs.chmodSync(fixture.file, mode);
    assert.equal(readSecretFile(fixture.file, NAME), 'mounted-secret');
  }
  fs.chmodSync(fixture.file, 0o600);
});
