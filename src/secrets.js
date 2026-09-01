'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATIC_SECRET_NAMES = new Set(['GITLAB_API_TOKEN', 'GITLAB_WEBHOOK_SIGNING_TOKEN', 'OPENAI_API_KEY', 'CODEX_PROVIDER_API_KEY']);
const NOTIFICATION_SECRET_SUFFIXES = '(?:WEBHOOK|SIGNING_SECRET|APP_ID|APP_SECRET|CHAT_ID)';

function isNotificationSecret(name) {
  return new RegExp(`^CODEX_REVIEW_NOTIFY_[A-Z0-9_]+_${NOTIFICATION_SECRET_SUFFIXES}$`).test(name);
}

function allowedSecretName(name) { return STATIC_SECRET_NAMES.has(name) || isNotificationSecret(name); }

function validateSecret(value, name) {
  const out = String(value ?? '').trim();
  if (!out) throw new Error(`${name} secret file is empty`);
  if (out.length > 65536 || /[\r\n\0]/.test(out)) throw new Error(`${name} secret value is invalid`);
  return out;
}

function readSecretFile(file, name, fsImpl = fs) {
  if (!path.isAbsolute(file)) throw new Error(`${name}_FILE must be an absolute path`);
  let stat;
  try { stat = fsImpl.statSync(file); } catch (cause) { const error = new Error(`${name}_FILE cannot be read: ${file}`); error.cause = cause; throw error; }
  if (!stat.isFile() || stat.size > 65536) throw new Error(`${name}_FILE must reference a regular file no larger than 64 KiB`);
  return validateSecret(fsImpl.readFileSync(file, 'utf8'), name);
}

function hydrateSecretEnv(env = process.env, fsImpl = fs) {
  for (const [key, raw] of Object.entries({ ...env })) {
    if (!key.endsWith('_FILE') || !String(raw || '').trim()) continue;
    const name = key.slice(0, -5);
    if (!allowedSecretName(name)) continue;
    const direct = String(env[name] || '').trim(), file = String(raw).trim();
    if (direct) throw new Error(`${name} and ${key} are mutually exclusive`);
    env[name] = readSecretFile(file, name, fsImpl);
  }
  return env;
}

module.exports = { hydrateSecretEnv, readSecretFile, allowedSecretName, isNotificationSecret, STATIC_SECRET_NAMES };
