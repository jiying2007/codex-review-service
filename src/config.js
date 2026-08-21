'use strict';

const path = require('node:path');

function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function numberEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean`);
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadConfig() {
  const dataDir = path.resolve(process.env.CODEX_REVIEW_DATA_DIR || '.data');
  const gitlabBaseUrl = required('GITLAB_BASE_URL').replace(/\/+$/, '');
  const gitlabToken = required('GITLAB_API_TOKEN');
  const webhookSigningToken = String(process.env.GITLAB_WEBHOOK_SIGNING_TOKEN || '').trim();
  const webhookSecretToken = String(process.env.GITLAB_WEBHOOK_SECRET_TOKEN || '').trim();
  if (!webhookSigningToken && !webhookSecretToken) {
    throw new Error('GITLAB_WEBHOOK_SIGNING_TOKEN or GITLAB_WEBHOOK_SECRET_TOKEN is required');
  }

  return {
    host: process.env.HOST || '127.0.0.1',
    port: intEnv('PORT', 8787, 1, 65535),
    dataDir,
    dbPath: path.join(dataDir, 'review-service.sqlite'),
    gitlabBaseUrl,
    gitlabApiUrl: `${gitlabBaseUrl}/api/v4`,
    gitlabToken,
    webhookSigningToken,
    webhookSecretToken,
    webhookMaxSkewSeconds: intEnv('WEBHOOK_MAX_SKEW_SECONDS', 300, 30, 3600),
    webhookMaxBodyBytes: intEnv('WEBHOOK_MAX_BODY_BYTES', 1024 * 1024, 4096, 10 * 1024 * 1024),
    botUsername: String(process.env.GITLAB_BOT_USERNAME || '').trim(),
    language: ['zh-CN', 'en'].includes(process.env.REVIEW_LANGUAGE) ? process.env.REVIEW_LANGUAGE : 'zh-CN',
    codexPath: String(process.env.CODEX_PATH || 'codex').trim() || 'codex',
    codexModel: String(process.env.CODEX_MODEL || '').trim(),
    codexHome: String(process.env.CODEX_HOME || '').trim(),
    reviewTimeoutSeconds: intEnv('REVIEW_TIMEOUT_SECONDS', 180, 30, 900),
    maxJobAttempts: intEnv('MAX_JOB_ATTEMPTS', 3, 1, 10),
    maxDiffBytes: intEnv('MAX_DIFF_BYTES', 1024 * 1024, 4096, 4 * 1024 * 1024),
    maxFindings: intEnv('MAX_FINDINGS', 40, 1, 100),
    minConfidence: numberEnv('MIN_CONFIDENCE', 0.7, 0, 1),
    pollIntervalMs: intEnv('WORKER_POLL_INTERVAL_MS', 1000, 100, 60000),
    statusName: String(process.env.GITLAB_STATUS_NAME || 'codex-review').trim() || 'codex-review',
    autoResolveObsolete: boolEnv('AUTO_RESOLVE_OBSOLETE', true),
    triggerOnOpen: boolEnv('TRIGGER_ON_OPEN', true),
    triggerOnPush: boolEnv('TRIGGER_ON_PUSH', true),
    triggerOnReopen: boolEnv('TRIGGER_ON_REOPEN', true)
  };
}

module.exports = { loadConfig, intEnv, numberEnv, boolEnv };
