'use strict';

// One OS process can host several isolated GitLab trust domains. Each domain
// owns its own worker thread, configuration, secrets, SQLite and Codex home.
// Do not turn a numeric GitLab project ID into a global primary key.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readSecretFile, allowedSecretName } = require('./secrets');
const { CONFIG_SCHEMA_VERSION } = require('./product-contract');
const { readControlJson } = require('./control-file');
const { validateStructuredConfig, positiveIds, parseGroups, validateSigningToken } = require('./config');

const INSTANCE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const ENV_ALLOWLIST = Object.freeze([
  'PATH','LANG','LC_ALL','TZ','TMPDIR','TEMP','TMP',
  'SYSTEMROOT','WINDIR','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE',
  'HTTPS_PROXY','HTTP_PROXY','NO_PROXY','https_proxy','http_proxy','no_proxy'
]);
function fail(message) {
  const error = new Error(message);
  error.code = 'EMULTIGITLABCONFIG';
  throw error;
}
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(label + ' must be an object');
  return value;
}
function exactKeys(value, names, label) {
  for (const key of Object.keys(value))
    if (!names.includes(key)) fail(label + ' has unsupported field ' + key);
}
function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))
    fail(label + ' must be an absolute path');
  return path.normalize(value);
}
function separate(a, b) {
  const left = path.resolve(a), right = path.resolve(b);
  const rel = path.relative(left, right);
  return left !== right && rel !== '' && rel !== '..' &&
    !rel.startsWith('..' + path.sep) &&
    !path.isAbsolute(rel);
}
function physicalLocation(value) {
  // Realpath the nearest existing ancestor so aliases such as /var -> /private/var
  // and symlinked Docker state parents cannot defeat per-instance DB isolation.
  const suffix=[];
  let base=path.resolve(value);
  while (!fs.existsSync(base)) {
    const parent=path.dirname(base);
    if (parent===base) fail('Cannot resolve the physical state directory');
    suffix.unshift(path.basename(base));
    base=parent;
  }
  let physical;
  try { physical=fs.realpathSync(base); }
  catch { fail('Cannot resolve the physical state directory'); }
  return path.join(physical,...suffix);
}
function overlaps(a, b) {
  return path.resolve(a) === path.resolve(b) || separate(a, b) || separate(b, a);
}
function normalizedUrl(raw, label) {
  let url;
  try { url = new URL(raw); } catch { fail(label + ' must be a valid GitLab http(s) URL'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash)
    fail(label + ' must be a GitLab base URL without credentials, query or fragment');
  const prefix=url.pathname.replace(/\/+$/,'');
  if(prefix && (!/^\/[A-Za-z0-9._/-]+$/.test(prefix) || prefix.split('/').includes('..')))
    fail(label + ' contains an unsafe GitLab relative path');
  return url.origin.toLowerCase()+prefix;
}
const MAX_CONFIG_BYTES = 1024 * 1024;
function fileJson(file, label) {
  let parsed;
  try {
    parsed = readControlJson(file, { maxBytes: MAX_CONFIG_BYTES });
  } catch {
    fail(label + ' must be valid UTF-8 JSON in a private, singly linked regular file of at most 1 MiB');
  }
  return record(parsed, label);
}
function validateInstance(raw, allFiles, identities) {
  const item = record(raw, 'instances[]');
  exactKeys(item, ['id','configFile','homeDir','secretFiles'], 'instances[]');
  const id = item.id;
  if (typeof id !== 'string' || !INSTANCE_ID.test(id))
    fail('instances[].id must be a lowercase, bounded route segment');
  const configFile = absolute(item.configFile, id + '.configFile');
  const homeDir = absolute(item.homeDir, id + '.homeDir');
  if (configFile === homeDir || overlaps(homeDir, configFile))
    fail(id + ' configFile and homeDir must be separate');
  if (allFiles.has(configFile)) fail('two instances share a config file');
  allFiles.add(configFile);
  const config = fileJson(configFile, id + '.configFile');
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION)
    fail(id + ' must use current standalone Config Schema ' + CONFIG_SCHEMA_VERSION);
  // Perform strict closed-key Schema 8 admission before any tenant worker
  // starts, so unknown/deprecated fields cannot partially start the gateway.
  try { validateStructuredConfig(config, configFile); }
  catch { fail(id + ' has invalid standalone Config Schema ' + CONFIG_SCHEMA_VERSION + ' fields'); }
  const server = record(config.server, id + '.server');
  const gitlab = record(config.gitlab, id + '.gitlab');
  const webhook = record(config.webhook, id + '.webhook');
  const codex = config.codex === undefined ? {} : record(config.codex, id + '.codex');
  const dataDir = absolute(server.dataDir, id + '.server.dataDir');
  if (overlaps(homeDir, dataDir)) fail(id + ' homeDir must not overlap SQLite state');
  if (codex.home && path.resolve(codex.home) !== homeDir)
    fail(id + ' codex.home must match the dedicated homeDir');
  // Validate the *same* numeric scope semantics as the existing Service
  // before any Worker can probe a foreign GitLab using the wrong allowlist.
  let projects,groups;
  try{
    projects=positiveIds(gitlab.projects,id + '.gitlab.projects');
    groups=parseGroups(gitlab.groups);
  }catch{
    fail(id + ' contains invalid GitLab project/group scope');
  }
  if(!projects.length && !groups.length)
    fail(id + ' must explicitly scope at least one GitLab project or group');
  // JS cannot represent GitLab identity integers past MAX_SAFE_INTEGER without
  // rounding. Refuse those IDs *before* they become authorization scope keys.
  if(projects.some(value=>!Number.isSafeInteger(value)) ||
      groups.some(group=>!Number.isSafeInteger(group.id)))
    fail(id + ' project/group scope contains an unsafe numeric ID');
  const origin = normalizedUrl(gitlab.baseUrl, id + '.gitlab.baseUrl');
  const expected = normalizedUrl(webhook.expectedInstance, id + '.webhook.expectedInstance');
  if (origin !== expected) fail(id + ' webhook instance must match its GitLab origin');
  const secrets = record(item.secretFiles, id + '.secretFiles');
  exactKeys(secrets, Object.keys(secrets).filter(key =>
    key.endsWith('_FILE') && allowedSecretName(key.slice(0, -5))), id + '.secretFiles');
  for (const name of ['GITLAB_API_TOKEN_FILE','GITLAB_WEBHOOK_SIGNING_TOKEN_FILE'])
    if (!secrets[name]) fail(id + ' requires a separate file-backed ' + name);
  const secretFiles = {};
  for (const [name, rawPath] of Object.entries(secrets)) {
    const file = absolute(rawPath, id + '.' + name);
    if (allFiles.has(file)) fail('two instances share a configuration or secret file');
    allFiles.add(file);
    let stat;
    try { stat=fs.lstatSync(file); }catch { fail(id + ' secret file is missing'); }
    if(stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 ||
       (process.platform !== 'win32' && (stat.mode & 0o022) !== 0))
      fail(id + ' secret must be a private, singly linked regular non-symlink file');
    const value = readSecretFile(file, name.slice(0, -5));
    if(name==='GITLAB_WEBHOOK_SIGNING_TOKEN_FILE'){
      // Reject a malformed 32-byte Standard Webhooks secret *before* starting
      // any tenant. The validator never includes the secret in a response.
      try{validateSigningToken(value);}
      catch{fail(id + ' webhook signing secret is malformed');}
    }
    // Compare hashes, never keep the credentials in the manifest or logs.
    if (name === 'GITLAB_API_TOKEN_FILE' || name === 'GITLAB_WEBHOOK_SIGNING_TOKEN_FILE') {
      const fingerprint = crypto.createHash('sha256').update(value).digest('hex');
      const label = name + ':' + fingerprint;
      if (identities.has(label)) fail('GitLab API or webhook credentials are shared between trust domains');
      identities.add(label);
    }
    secretFiles[name] = file;
  }
  const preflightScope=Object.freeze({projects:Object.freeze([...projects]),
    groups:Object.freeze(groups.map(group=>Object.freeze({...group})))});
  return Object.freeze({id, configFile, homeDir, dataDir, origin,
    preflightScope,secretFiles:Object.freeze(secretFiles)});
}
function loadMultiManifest(file = process.env.CODEX_REVIEW_MULTI_CONFIG_FILE) {
  const pathname = absolute(file, 'CODEX_REVIEW_MULTI_CONFIG_FILE');
  const root = fileJson(pathname, 'multi-instance manifest');
  exactKeys(root, ['schemaVersion','server','instances'], 'multi-instance manifest');
  if (root.schemaVersion !== 2) fail('explicit-instance multi-GitLab manifest Schema 2 is required');
  const server = record(root.server, 'server');
  exactKeys(server, ['host','port','sharedProcessTrustAcknowledged'], 'server');
  if(server.sharedProcessTrustAcknowledged!==true)
    fail('server.sharedProcessTrustAcknowledged must explicitly acknowledge one OS process is not a hard security boundary');
  const host = server.host;
  const port = server.port;
  if (typeof host !== 'string' || !host || /[\s\/\\\0]/.test(host))
    fail('server.host must be a safe bind address');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    fail('server.port must be an integer from 1 to 65535');
  if (!Array.isArray(root.instances) || root.instances.length < 1 || root.instances.length > 16)
    fail('instances must contain 1-16 isolated GitLab tenants');
  const ids = new Set(), allFiles = new Set([pathname]), identities = new Set();
  const instances = root.instances.map(item => {
    const instance = validateInstance(item, allFiles, identities);
    if (ids.has(instance.id)) fail('duplicate GitLab instance ID: ' + instance.id);
    ids.add(instance.id);
    return instance;
  });
  for (let i=0;i<instances.length;i++) for (let j=i+1;j<instances.length;j++) {
    const left = instances[i], right = instances[j];
    if (overlaps(physicalLocation(left.dataDir), physicalLocation(right.dataDir)))
      fail('SQLite state directories overlap between instances');
    if (overlaps(physicalLocation(left.homeDir), physicalLocation(right.homeDir)))
      fail('Codex homes overlap between instances');
    if (overlaps(physicalLocation(left.dataDir), physicalLocation(right.homeDir)) ||
        overlaps(physicalLocation(right.dataDir), physicalLocation(left.homeDir)))
      fail('SQLite state and other instance Codex home directories overlap');
    if (left.origin === right.origin) fail('duplicate GitLab origin across instances');
  }
  const reserved=instances.flatMap(instance=>[physicalLocation(instance.dataDir),physicalLocation(instance.homeDir)]);
  for(const file of allFiles){
    const physical=physicalLocation(file);
    if(reserved.some(dir=>overlaps(physical,dir)))
      fail('Configuration or secret file must not live inside a writable tenant state/home directory');
  }
  return Object.freeze({
    server: Object.freeze({host,port,sharedProcessTrustAcknowledged:true}),
    instances: Object.freeze(instances)
  });
}
function buildWorkerEnv(instance, parentEnv=process.env) {
  const env={};
  for (const name of ENV_ALLOWLIST)
    if (typeof parentEnv[name] === 'string') env[name] = parentEnv[name];
  env.HOME = instance.homeDir;
  env.CODEX_HOME = instance.homeDir;
  env.CODEX_REVIEW_CONFIG_FILE = instance.configFile;
  for (const [name,file] of Object.entries(instance.secretFiles)) env[name] = file;
  return env;
}
module.exports={loadMultiManifest,buildWorkerEnv,physicalLocation,overlaps,normalizedUrl,INSTANCE_ID};
