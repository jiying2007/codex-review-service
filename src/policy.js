'use strict';

const crypto = require('node:crypto');
const { SEVERITIES } = require('./config');

const PROJECT_RULE_KEYS = new Set(['language', 'maxDiffBytes', 'maxFindings', 'severityThreshold', 'timeoutSeconds', 'extraInstructions']);
const SEVERITY_ORDER = Object.freeze({ critical: 5, high: 4, medium: 3, low: 2, info: 1 });

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}
function fingerprint(value) { return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value)), 'utf8').digest('hex'); }
function policyError(message) { const error = new Error(message); error.code = 'EPROJECTPOLICY'; return error; }
function boundedInteger(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw policyError(`${name} is outside the allowed range`);
  return n;
}

function parseProjectPolicy(text, config) {
  if (Buffer.byteLength(text, 'utf8') > config.projectPolicyMaxBytes) throw policyError(`${config.projectPolicyFile} exceeds PROJECT_POLICY_MAX_BYTES`);
  let value;
  try { value = JSON.parse(text); } catch (cause) { const error = policyError(`${config.projectPolicyFile} is not valid JSON`); error.cause = cause; throw error; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw policyError(`${config.projectPolicyFile} must contain a JSON object`);
  const unknown = Object.keys(value).filter(key => !PROJECT_RULE_KEYS.has(key));
  if (unknown.length) throw policyError(`${config.projectPolicyFile} contains unsupported fields: ${unknown.join(', ')}`);
  const rules = {};
  if (value.language !== undefined) {
    if (!['zh-CN', 'en'].includes(value.language)) throw policyError('language must be zh-CN or en');
    rules.language = value.language;
  }
  if (value.maxDiffBytes !== undefined) rules.maxDiffBytes = boundedInteger(value.maxDiffBytes, 'maxDiffBytes', 4096, 4 * 1024 * 1024);
  if (value.maxFindings !== undefined) rules.maxFindings = boundedInteger(value.maxFindings, 'maxFindings', 1, 100);
  if (value.timeoutSeconds !== undefined) rules.timeoutSeconds = boundedInteger(value.timeoutSeconds, 'timeoutSeconds', 10, 900);
  if (value.severityThreshold !== undefined) {
    const severity = String(value.severityThreshold);
    if (!SEVERITIES.includes(severity)) throw policyError(`severityThreshold must be one of: ${SEVERITIES.join(', ')}`);
    if (SEVERITY_ORDER[severity] > SEVERITY_ORDER[config.blockingSeverity]) throw policyError(`severityThreshold cannot hide globally blocking ${config.blockingSeverity} findings`);
    rules.severityThreshold = severity;
  }
  if (value.extraInstructions !== undefined) {
    if (typeof value.extraInstructions !== 'string') throw policyError('extraInstructions must be a string');
    const textValue = value.extraInstructions.trim();
    if (textValue.length > 5000 || /\0/.test(textValue)) throw policyError('extraInstructions must not exceed 5000 characters');
    rules.extraInstructions = textValue;
  }
  return rules;
}

async function getEffectivePolicy(gitlab, projectId, mr, config) {
  const defaults = {
    language: config.language, maxDiffBytes: config.maxDiffBytes, maxFindings: config.maxFindings,
    severityThreshold: 'info', timeoutSeconds: config.reviewTimeoutSeconds, extraInstructions: '',
    blockingSeverity: config.blockingSeverity, maxReviewChunks: config.maxReviewChunks,
    maxPublishedFindings: config.maxPublishedFindings, minConfidence: config.minConfidence
  };
  if (!config.projectPolicyEnabled) return Object.freeze({ ...defaults, source: 'service-default', fingerprint: fingerprint(defaults) });
  const policyRef = String(mr.diff_refs?.start_sha || '').trim();
  if (!policyRef) throw policyError('Merge request diff_refs.start_sha is unavailable for project policy snapshot');
  const raw = await gitlab.getRepositoryFileRaw(projectId, config.projectPolicyFile, policyRef);
  if (raw === null) return Object.freeze({ ...defaults, source: 'target-default', fingerprint: fingerprint(defaults) });
  const project = parseProjectPolicy(raw, config);
  const effective = {
    ...defaults, ...project,
    maxDiffBytes: Math.min(project.maxDiffBytes ?? defaults.maxDiffBytes, config.maxDiffBytes),
    maxFindings: Math.min(project.maxFindings ?? defaults.maxFindings, config.maxFindings),
    timeoutSeconds: Math.min(project.timeoutSeconds ?? defaults.timeoutSeconds, config.reviewTimeoutSeconds),
    source: `target:${config.projectPolicyFile}@${policyRef.slice(0, 12)}`
  };
  effective.fingerprint = fingerprint({ ...effective, source: undefined });
  return Object.freeze(effective);
}

module.exports = { PROJECT_RULE_KEYS, SEVERITY_ORDER, parseProjectPolicy, getEffectivePolicy, fingerprint, policyError };
