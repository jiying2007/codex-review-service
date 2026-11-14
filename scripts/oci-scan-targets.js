'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMAGE = /^ghcr\.io\/jiying2007\/codex-review-service:\d+\.\d+\.\d+$/;
const PLATFORMS = ['linux/amd64', 'linux/arm64'];
function fail(message) { throw Object.assign(new Error(message), { code: 'EOCISCANTARGET' }); }
function parseDigestBound(bytes, digest) {
  if (!Buffer.isBuffer(bytes) || !DIGEST.test(digest) ||
      'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex') !== digest)
    fail('OCI registry bytes do not match their expected digest');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { fail('OCI registry object is not strict UTF-8 JSON'); }
}
function validateTargets(value) {
  if (value?.schemaVersion !== 1 || !IMAGE.test(value.imageRef) || !DIGEST.test(value.indexDigest) ||
      !Array.isArray(value.platforms) || value.platforms.length !== 2) fail('Incomplete OCI scan targets');
  const platforms = new Set(), manifests = new Set(), configs = new Set();
  for (const target of value.platforms) {
    if (!PLATFORMS.includes(target?.platform) || platforms.has(target.platform) ||
        !DIGEST.test(target.manifestDigest) || !DIGEST.test(target.configDigest) ||
        manifests.has(target.manifestDigest) || configs.has(target.configDigest) ||
        target.imageRef !== value.imageRef + '@' + target.manifestDigest) fail('Ambiguous OCI platform identity');
    platforms.add(target.platform); manifests.add(target.manifestDigest); configs.add(target.configDigest);
  }
  return value;
}
function resolveScanTargets({ imageRef, indexDigest }, inspect) {
  if (!IMAGE.test(imageRef) || !DIGEST.test(indexDigest) || typeof inspect !== 'function')
    fail('Exact canonical OCI image and index digest are required');
  const index = parseDigestBound(inspect(imageRef + '@' + indexDigest), indexDigest);
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests)) fail('OCI image index is missing manifests');
  const platforms = PLATFORMS.map(platform => {
    const [os, architecture] = platform.split('/');
    const matches = index.manifests.filter(item => item?.platform?.os === os && item?.platform?.architecture === architecture);
    if (matches.length !== 1 || !DIGEST.test(matches[0].digest)) fail('One manifest per required platform is mandatory');
    const manifestDigest = matches[0].digest;
    const reference = imageRef + '@' + manifestDigest;
    const manifest = parseDigestBound(inspect(reference), manifestDigest);
    if (manifest.schemaVersion !== 2 || !DIGEST.test(manifest.config?.digest) ||
        !Array.isArray(manifest.layers) || !manifest.layers.length ||
        manifest.layers.some(layer => !DIGEST.test(layer?.digest))) fail('OCI image manifest lacks config or layer identities');
    return { platform, imageRef: reference, manifestDigest, configDigest: manifest.config.digest };
  });
  return validateTargets({ schemaVersion: 1, imageRef, indexDigest, platforms });
}
function main(args = process.argv.slice(2)) {
  if (args.length !== 3) fail('Usage: oci-scan-targets.js IMAGE INDEX_DIGEST OUTPUT_JSON');
  const [imageRef, indexDigest, output] = args;
  const value = resolveScanTargets({ imageRef, indexDigest }, reference => execFileSync('docker',
    ['buildx', 'imagetools', 'inspect', reference, '--raw'], { timeout: 120000, maxBuffer: 16 * 1024 * 1024 }));
  fs.writeFileSync(output, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  if (process.env.GITHUB_OUTPUT) {
    const rows = value.platforms.flatMap(target => {
      const arch = target.platform.split('/')[1];
      return [arch + '_image=' + target.imageRef, arch + '_config=' + target.configDigest];
    });
    fs.appendFileSync(process.env.GITHUB_OUTPUT, rows.join('\n') + '\n');
  }
  console.log(JSON.stringify(value));
  return value;
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(String(error.code || 'EOCISCANTARGET') + ': ' + error.message); process.exitCode = 2; }
}
module.exports = { parseDigestBound, resolveScanTargets, validateTargets, main };
