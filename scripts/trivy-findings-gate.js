'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { validateTargets } = require('./oci-scan-targets');
const contract = require('../product-contract.json');

const FIXED_PACKAGES = Object.freeze({ apt: '3.0.4', 'libapt-pkg7.0': '3.0.4',
  'libpcre2-8-0': '10.46-1~deb13u3', zlib1g: '1:1.3.dfsg+really1.3.1-1+deb13u1',
  gzip: '1.13-1+deb13u1', 'libsqlite3-0': '3.46.1-7+deb13u2', 'libssl3t64': '3.5.7-1~deb13u3',
  'openssl-provider-legacy': '3.5.7-1~deb13u3', 'perl-base': '5.40.1-6+deb13u1' });
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SEVERITIES = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
function fail(message) { throw Object.assign(new Error(message), { code: 'ETRIVYREPORT' }); }
function readJson(file) {
  const bytes = fs.readFileSync(file);
  if (!bytes.length || bytes.length > 64 * 1024 * 1024) fail('Missing or oversized Trivy evidence');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { fail('Scan evidence is not strict UTF-8 JSON'); }
}
function atLeastDebianVersion(installed, minimum) {
  if (typeof installed !== 'string' || !/^[0-9][0-9A-Za-z.+:~\-]*$/.test(installed)) fail('Invalid Debian package version');
  if (installed === minimum) return true;
  const result = spawnSync('dpkg', ['--compare-versions', installed, 'ge', minimum], { encoding: 'utf8', timeout: 5000 });
  if (result.error || ![0, 1].includes(result.status)) fail('Debian version comparison could not be verified');
  return result.status === 0;
}
function debianInventoryVersion(pkg) {
  if (typeof pkg?.Version !== 'string' || !/^[0-9][0-9A-Za-z.+~\-]*$/.test(pkg.Version) ||
      (pkg.Release !== undefined && (typeof pkg.Release !== 'string' ||
        (pkg.Release !== '' && !/^[0-9A-Za-z.+~]+$/.test(pkg.Release)))) ||
      (pkg.Epoch !== undefined && (!Number.isSafeInteger(pkg.Epoch) || pkg.Epoch < 0)))
    fail('Malformed Debian version, release or epoch in package inventory');
  return (pkg.Epoch ? String(pkg.Epoch) + ':' : '') + pkg.Version + (pkg.Release ? '-' + pkg.Release : '');
}
function assess(report, { image, imageId, platform, revision }) {
  if (typeof image !== 'string' || !image || !DIGEST.test(imageId) ||
      !['linux/amd64', 'linux/arm64'].includes(platform) || !/^[0-9a-f]{40}$/.test(revision)) fail('Exact image, config, platform and source SHA are required');
  const config = report?.Metadata?.ImageConfig;
  const [os, architecture] = platform.split('/');
  // Trivy 0.70 reports a digest-bound remote scan's *manifest* in
  // Metadata.ImageID. The caller's imageId is the separately verified OCI
  // *config* digest from the raw child manifest. These are not interchangeable.
  const childDigest=/@(sha256:[0-9a-f]{64})$/.exec(image)?.[1]||null;
  const repoTag=childDigest?image.slice(0,-childDigest.length-1):'';
  const repository=repoTag?repoTag.replace(/:[^/:]*$/,''):'';
  const canonical=childDigest?repository+'@'+childDigest:'';
  const exactRegistryIdentity=childDigest?
    (report?.Metadata?.ImageID===childDigest &&
      report?.Metadata?.Reference===canonical &&
      Array.isArray(report?.Metadata?.RepoDigests) &&
      report.Metadata.RepoDigests.includes(canonical)):
    report?.Metadata?.ImageID===imageId;
  if (report?.SchemaVersion !== 2 || report.ArtifactType !== 'container_image' || report.ArtifactName !== image ||
      !exactRegistryIdentity || config?.os !== os || config?.architecture !== architecture ||
      config?.config?.Labels?.['org.opencontainers.image.revision'] !== revision ||
      config?.config?.Labels?.['org.opencontainers.image.version'] !== contract.serviceVersion ||
      config?.config?.Labels?.['org.opencontainers.image.source'] !== 'https://github.com/jiying2007/codex-review-service' ||
      report.Metadata?.OS?.Family !== 'debian' || !/^13(?:\.|$)/.test(String(report.Metadata.OS.Name)) ||
      !Array.isArray(report.Results) || !report.Results.length) fail('Trivy report does not identify the expected image and platform');
  if (report.Trivy?.Version !== '0.70.0') fail('Missing or unexpected Trivy scanner version');
  const osResults = report.Results.filter(result => result?.Class === 'os-pkgs' && result.Type === 'debian');
  if (osResults.length !== 1 || !Array.isArray(osResults[0].Packages) || !osResults[0].Packages.length)
    fail('Complete Debian package inventory is required');
  const packages = {};
  for (const [name, minimum] of Object.entries(FIXED_PACKAGES)) {
    const matches = osResults[0].Packages.filter(pkg => pkg?.Name === name);
    if (matches.length !== 1 || matches[0].Arch !== architecture) fail('Required native Debian package is absent: ' + name);
    const installed = debianInventoryVersion(matches[0]);
    if (!atLeastDebianVersion(installed, minimum)) fail('Required Debian security fix is absent: ' + name);
    packages[name] = installed;
  }
  const blocking = [];
  const counts = { total: 0, critical: 0, fixableHigh: 0, unfixedHigh: 0 };
  for (const result of report.Results) {
    if (!result || typeof result.Target !== 'string' || !result.Target ||
        (result.Vulnerabilities !== undefined && !Array.isArray(result.Vulnerabilities)) ||
        (result.ExperimentalModifiedFindings !== undefined &&
          (!Array.isArray(result.ExperimentalModifiedFindings) || result.ExperimentalModifiedFindings.length)))
      fail('Incomplete or filtered Trivy result');
    for (const finding of result.Vulnerabilities || []) {
      if (!finding || !SEVERITIES.includes(finding.Severity) || typeof finding.VulnerabilityID !== 'string' ||
          !finding.VulnerabilityID || typeof finding.PkgName !== 'string' || !finding.PkgName ||
          typeof finding.InstalledVersion !== 'string' || !finding.InstalledVersion ||
          (finding.FixedVersion !== undefined && typeof finding.FixedVersion !== 'string')) fail('Malformed Trivy vulnerability');
      const fixed = (finding.FixedVersion || '').trim();
      if (finding.Status === 'fixed' && !fixed) fail('Fixed vulnerability lacks a fixed version');
      counts.total++;
      if (finding.Severity === 'CRITICAL') counts.critical++;
      if (finding.Severity === 'HIGH') counts[fixed ? 'fixableHigh' : 'unfixedHigh']++;
      if (finding.Severity === 'CRITICAL' || (finding.Severity === 'HIGH' && fixed))
        blocking.push({ target: result.Target, id: finding.VulnerabilityID, package: finding.PkgName,
          severity: finding.Severity, installedVersion: finding.InstalledVersion, fixedVersion: fixed });
    }
  }
  return { ok: blocking.length === 0, policy: 'all-critical-and-fixable-high', image, imageId, manifestDigest:childDigest, platform, sourceSha: revision,
    scannerVersion: report.Trivy.Version, productVersion: contract.serviceVersion, packages, counts, blocking };
}
function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--report', '--image', '--image-id', '--platform', '--revision', '--targets'].includes(key) ||
        !args[i + 1] || options[key] !== undefined) fail('Invalid scan gate arguments');
    options[key] = args[i + 1];
  }
  let image = options['--image'], imageId = options['--image-id'];
  if (options['--targets']) {
    if (image || imageId) fail('Choose registry targets or an exact local image identity');
    const targets = validateTargets(readJson(options['--targets']));
    const target = targets.platforms.find(item => item.platform === options['--platform']);
    if (!target) fail('Expected platform scan target is absent');
    image = target.imageRef; imageId = target.configDigest;
  }
  if (!options['--report']) fail('Trivy JSON report is required');
  const result = assess(readJson(options['--report']), { image, imageId, platform: options['--platform'], revision: options['--revision'] });
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}
if (require.main === module) {
  try { process.exitCode = main(); } catch (error) { console.error(String(error.code || 'ETRIVYREPORT') + ': ' + error.message); process.exitCode = 2; }
}
module.exports = { FIXED_PACKAGES, atLeastDebianVersion, debianInventoryVersion, assess, main };
