'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CURRENT_DOCS } = require('../scripts/sync-operational-docs');

const root = path.resolve(__dirname, '..');
const fixtureFiles = [
  'product-contract.json',
  'config.example.json',
  'scripts/generate-contract-docs.js',
  'scripts/sync-operational-docs.js',
  'src/codex-safe-core/core-contract.json',
  ...CURRENT_DOCS
];
const nextCore = { commit: 'b'.repeat(40), version: '4.99.0' };

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-service-docs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const relative of fixtureFiles) {
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
  }
  const contractPath = path.join(directory, 'product-contract.json');
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  contract.safeCoreCommit = nextCore.commit;
  contract.safeCoreVersion = nextCore.version;
  fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  return directory;
}

function documentSnapshot(directory) {
  return Object.fromEntries(CURRENT_DOCS.map(relative => [
    relative, fs.readFileSync(path.join(directory, relative), 'utf8')
  ]));
}

function run(directory, args) {
  return execFileSync(process.execPath, args, {
    cwd: directory, encoding: 'utf8', timeout: 15000
  });
}

test('requiring the document generator preserves its pure exports without writes or subprocesses', t => {
  const directory = fixture(t);
  const before = documentSnapshot(directory);
  const result = JSON.parse(run(directory, ['-e', `
    const fs = require('node:fs');
    const child = require('node:child_process');
    const deny = () => { throw new Error('document generator import must have no write or subprocess side effects'); };
    for (const name of ['writeFileSync', 'appendFileSync', 'renameSync']) fs[name] = deny;
    for (const name of ['execFileSync', 'spawnSync', 'spawn', 'exec', 'execFile', 'fork']) child[name] = deny;
    const generator = require('./scripts/generate-contract-docs');
    process.stdout.write(JSON.stringify({
      exports: Object.keys(generator).sort(),
      coreLine: generator.contractLines().find(line => line.startsWith('Safe Core ')),
      generatedContract: generator.productContractDoc().includes(generator.START)
    }));
  `]));
  assert.deepEqual(result.exports, [
    'START', 'END', 'contractLines', 'block', 'readmeBlock',
    'replaceGenerated', 'ensureReadmeBlock', 'productContractDoc'
  ].sort());
  assert.equal(result.coreLine, `Safe Core ${nextCore.commit}`);
  assert.equal(result.generatedContract, true);
  assert.deepEqual(documentSnapshot(directory), before);
});

test('the direct repin generator synchronizes operational Core identity and is idempotent', t => {
  const directory = fixture(t);
  run(directory, ['scripts/generate-contract-docs.js']);
  const generated = documentSnapshot(directory);
  assert.ok(generated['LONG_TERM_ASSET.md'].includes(`exact Safe Core commit \`${nextCore.commit}\``));
  assert.ok(generated['LONG_TERM_ASSET.md'].includes(`exact Safe Core ${nextCore.version} accurately`));
  for (const file of ['docs/CODEX_PROVIDER.md', 'docs/CODEX_PROVIDER.zh-CN.md']) {
    assert.ok(generated[file].includes(`Codex Safe Core ${nextCore.version} Runtime/Provider Contract`), file);
  }
  for (const file of ['docs/QUALITY_PLATFORM.md', 'docs/QUALITY_PLATFORM.zh-CN.md']) {
    assert.ok(generated[file].includes(`Safe Core ${nextCore.version}`), file);
  }

  execFileSync('git', ['init', '-q'], { cwd: directory });
  execFileSync('git', ['add', '--all'], { cwd: directory });
  run(directory, ['scripts/sync-operational-docs.js', '--check']);
  run(directory, ['scripts/generate-contract-docs.js']);
  assert.deepEqual(documentSnapshot(directory), generated);
  run(directory, ['scripts/sync-operational-docs.js', '--check']);
});
