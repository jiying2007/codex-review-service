'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveScanTargets } = require('../scripts/oci-scan-targets');
const { assess, FIXED_PACKAGES } = require('../scripts/trivy-findings-gate');
const version = require('../product-contract.json').serviceVersion;
const revision = 'a'.repeat(40), image = 'codex-review-service:ci', imageId = 'sha256:' + 'b'.repeat(64);
const options = { image, imageId, revision, platform: 'linux/amd64' };
const hash = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const bytes = value => Buffer.from(JSON.stringify(value));

function report() {
  return { SchemaVersion: 2, Trivy: { Version: '0.70.0' }, ArtifactName: image, ArtifactType: 'container_image',
    Metadata: { ImageID: imageId, OS: { Family: 'debian', Name: '12.15' },
      ImageConfig: { architecture: 'amd64', os: 'linux', config: { Labels: {
        'org.opencontainers.image.revision': revision,
        'org.opencontainers.image.version': version,
        'org.opencontainers.image.source': 'https://github.com/jiying2007/codex-review-service'
      } } } },
    Results: [{ Target: 'debian 12.15', Class: 'os-pkgs', Type: 'debian',
      Packages: Object.entries(FIXED_PACKAGES).map(([Name, Version]) => ({ Name, Version })) }] };
}
function finding(Severity, FixedVersion, extra = {}) {
  return { VulnerabilityID: 'CVE-2026-1234', PkgName: 'example', InstalledVersion: '1.0', Severity,
    ...(FixedVersion === undefined ? {} : { FixedVersion }), ...extra };
}
function registry() {
  const imageRef = 'ghcr.io/jiying2007/codex-review-service:' + version;
  const raw = new Map();
  const manifests = ['amd64', 'arm64'].map((architecture, i) => {
    const manifest = bytes({ schemaVersion: 2, config: { digest: 'sha256:' + String(i + 3).repeat(64) },
      layers: [{ digest: 'sha256:' + '7'.repeat(64) }] });
    const digest = hash(manifest); raw.set(imageRef + '@' + digest, manifest);
    return { digest, platform: { os: 'linux', architecture } };
  });
  const index = { schemaVersion: 2, manifests };
  const make = () => {
    const value = bytes(index), indexDigest = hash(value); raw.set(imageRef + '@' + indexDigest, value);
    return { imageRef, indexDigest };
  };
  return { index, raw, make, inspect: reference => raw.get(reference) };
}

test('OCI scan targets bind both child manifests and config digests to original registry bytes', () => {
  const f = registry(), result = resolveScanTargets(f.make(), f.inspect);
  assert.deepEqual(result.platforms.map(p => p.platform), ['linux/amd64', 'linux/arm64']);
  assert.equal(new Set(result.platforms.map(p => p.configDigest)).size, 2);
  for (const target of result.platforms) assert.equal(target.imageRef, result.imageRef + '@' + target.manifestDigest);
});

test('OCI byte changes, absent or duplicate architectures cannot provide scan authority', () => {
  const f = registry(), input = f.make();
  assert.throws(() => resolveScanTargets(input, ref => Buffer.concat([f.inspect(ref), Buffer.from('\n')])), /expected digest/);
  const child = f.index.manifests[0].digest;
  assert.throws(() => resolveScanTargets(input, ref => ref.endsWith(child) ? Buffer.from('{}') : f.inspect(ref)), /expected digest/);
  f.index.manifests.pop();
  assert.throws(() => resolveScanTargets(f.make(), f.inspect), /One manifest/);
  f.index.manifests.push(f.index.manifests[0]);
  assert.throws(() => resolveScanTargets(f.make(), f.inspect), /One manifest/);
});

test('patched complete inventory passes while unfixed High remains visible', () => {
  const value = report(); value.Results[0].Vulnerabilities = [finding('HIGH')];
  const result = assess(value, options);
  assert.equal(result.ok, true); assert.equal(result.counts.unfixedHigh, 1);
  assert.deepEqual(result.packages, FIXED_PACKAGES); assert.equal(result.scannerVersion, '0.70.0');
});

test('every Critical and every fixable High blocks, including Critical with no fix', () => {
  const value = report(); value.Results[0].Vulnerabilities = [finding('CRITICAL'), finding('CRITICAL', '2'),
    finding('HIGH', '2'), finding('HIGH'), finding('MEDIUM', '2')];
  const result = assess(value, options);
  assert.equal(result.ok, false); assert.equal(result.blocking.length, 3);
  assert.deepEqual(result.counts, { total: 5, critical: 2, fixableHigh: 1, unfixedHigh: 1 });
  value.Results[0].Vulnerabilities = [finding('HIGH', '', { Status: 'fixed' })];
  assert.throws(() => assess(value, options), /lacks a fixed version/);
});

test('the six published 7.7.1 High findings and vulnerable package inventory cannot qualify', () => {
  const value = report();
  value.Results[0].Packages = [
    { Name: 'apt', Version: '2.6.1' }, { Name: 'libapt-pkg6.0', Version: '2.6.1' },
    { Name: 'libpcre2-8-0', Version: '10.42-1' }
  ];
  value.Results[0].Vulnerabilities = [
    ['apt', 'CVE-2026-109518', '2.6.1', '2.6.2'],
    ['libapt-pkg6.0', 'CVE-2026-109518', '2.6.1', '2.6.2'],
    ...['103111', '86145', '89157', '89161'].map(id => ['libpcre2-8-0', 'CVE-2026-' + id, '10.42-1', '10.42-1+deb12u2'])
  ].map(([PkgName, VulnerabilityID, InstalledVersion, FixedVersion]) =>
    finding('HIGH', FixedVersion, { PkgName, VulnerabilityID, InstalledVersion, Status: 'fixed' }));
  assert.throws(() => assess(value, options), /Required Debian security fix is absent|version comparison could not/);
  value.Results[0].Packages = report().Results[0].Packages;
  assert.equal(assess(value, options).blocking.length, 6);
});

test('missing inventories, foreign images, unknown scanner and filtered or malformed findings fail closed', () => {
  const mutations = [
    v => { delete v.Trivy; }, v => { v.Trivy.Version = '0.69.0'; },
    v => { v.ArtifactName = 'other:tag'; }, v => { v.Metadata.ImageID = 'sha256:' + '0'.repeat(64); },
    v => { v.Metadata.ImageConfig.architecture = 'arm64'; },
    v => { v.Metadata.ImageConfig.config.Labels['org.opencontainers.image.revision'] = 'f'.repeat(40); },
    v => { v.Metadata.ImageConfig.config.Labels['org.opencontainers.image.version'] = '7.7.0'; },
    v => { v.Results = []; }, v => { delete v.Results[0].Packages; },
    v => { v.Results[0].Packages.pop(); }, v => { v.Results[0].Packages.push(v.Results[0].Packages[0]); },
    v => { v.Results[0].Vulnerabilities = {}; },
    v => { v.Results[0].Vulnerabilities = [finding('UNRECOGNIZED', '2')]; },
    v => { v.Results[0].ExperimentalModifiedFindings = [{ ignored: true }]; }
  ];
  for (const mutate of mutations) {
    const value = report(); mutate(value);
    assert.throws(() => assess(value, options), { code: 'ETRIVYREPORT' });
  }
});

test('actual scan gate CLI distinguishes clean, blocking and incomplete JSON evidence', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-trivy-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'report.json');
  const command = path.resolve(__dirname, '../scripts/trivy-findings-gate.js');
  const run = value => {
    fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    return spawnSync(process.execPath, [command, '--report', file, '--image', image, '--image-id', imageId,
      '--platform', options.platform, '--revision', revision], { encoding: 'utf8', timeout: 10000 });
  };
  let r = run(report()); assert.equal(r.status, 0, r.stderr);
  const blocked = report(); blocked.Results[0].Vulnerabilities = [finding('CRITICAL')];
  r = run(blocked); assert.equal(r.status, 1, r.stderr); assert.equal(JSON.parse(r.stdout).blocking.length, 1);
  for (const broken of ['{', '{}', Buffer.from([0xff])]) {
    r = run(broken); assert.equal(r.status, 2); assert.match(r.stderr, /ETRIVYREPORT/);
  }
});
