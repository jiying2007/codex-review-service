'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { outputSchema } = require('./review');

const REQUIRED_TOP_FLAGS = Object.freeze(['--ask-for-approval']);
const REQUIRED_EXEC_FLAGS = Object.freeze([
  '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config',
  '--ignore-rules', '--sandbox', '--output-schema', '--config'
]);
const SAFE_CONFIG_OVERRIDES = Object.freeze([
  'web_search="disabled"',
  'features.shell_tool=false',
  'features.unified_exec=false',
  'features.shell_snapshot=false',
  'features.apps=false',
  'features.multi_agent=false',
  'features.remote_plugin=false',
  'features.hooks=false',
  'features.goals=false',
  'features.memories=false',
  'features.skill_mcp_dependency_install=false'
]);

let capabilityCache = null;

function filteredEnv(config) {
  const env = {};
  for (const key of ['PATH','HOME','USERPROFILE','LANG','LC_ALL','TMPDIR','TEMP','TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (config.codexHome) env.CODEX_HOME = config.codexHome;
  if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  return env;
}

function buildCodexArgs(schemaPath, model) {
  const args = [
    '--ask-for-approval', 'never',
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox', 'read-only',
    '--output-schema', schemaPath
  ];
  for (const value of SAFE_CONFIG_OVERRIDES) args.push('--config', value);
  if (model) args.push('--model', model);
  args.push('-');
  return args;
}

function capture(command, args, config, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: filteredEnv(config),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error(`Codex capability probe exited with code ${code}`);
        error.code = 'ECODEXCAPABILITY';
        error.stderr = stderr.slice(0, 1000);
        reject(error);
      }
    });
  });
}

async function probeCodexCapabilities(config, force = false) {
  const cacheKey = `${config.codexPath}\n${config.codexModel || ''}`;
  if (!force && capabilityCache?.key === cacheKey) return capabilityCache.value;
  let versionResult;
  let top;
  let exec;
  try {
    [versionResult, top, exec] = await Promise.all([
      capture(config.codexPath, ['--version'], config),
      capture(config.codexPath, ['--help'], config),
      capture(config.codexPath, ['exec', '--help'], config)
    ]);
  } catch (error) {
    if (!error.code || error.code === 'ENOENT') error.code = 'ECODEXCAPABILITY';
    throw error;
  }
  const topHelp = `${top.stdout}\n${top.stderr}`;
  const execHelp = `${exec.stdout}\n${exec.stderr}`;
  const missing = [
    ...REQUIRED_TOP_FLAGS.filter(flag => !topHelp.includes(flag)).map(flag => `top-level ${flag}`),
    ...REQUIRED_EXEC_FLAGS.filter(flag => !execHelp.includes(flag)).map(flag => `exec ${flag}`)
  ];
  if (config.codexModel && !`${topHelp}\n${execHelp}`.includes('--model')) missing.push('--model');
  if (missing.length) {
    const error = new Error(`Codex CLI does not expose required capabilities: ${missing.join(', ')}`);
    error.code = 'ECODEXVERSION';
    error.missingFlags = missing;
    throw error;
  }
  const value = { version: String(versionResult.stdout || versionResult.stderr).trim() || 'unknown' };
  capabilityCache = { key: cacheKey, value };
  return value;
}

function parseJsonl(stdout) {
  let lastAgentMessage = '';
  const errors = [];
  for (const line of String(stdout || '').split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { throw Object.assign(new Error('Codex --json returned invalid JSONL'), { code: 'ECODEXOUTPUT' }); }
    if (event?.type === 'item.completed' && event?.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      lastAgentMessage = event.item.text;
    }
    if (event?.type === 'error') errors.push(event.message || event.error?.message || 'Codex error');
    if (event?.type === 'turn.failed') errors.push(event.error?.message || event.message || 'Codex turn failed');
  }
  if (!lastAgentMessage && errors.length) throw Object.assign(new Error(errors.join('; ')), { code: 'ECODEXTURN' });
  if (!lastAgentMessage) throw Object.assign(new Error('Codex JSONL did not contain a final agent_message'), { code: 'ECODEXOUTPUT' });
  return lastAgentMessage.trim();
}

function compatibilityError(stderr) {
  const text = String(stderr || '').toLowerCase();
  return ['unexpected argument','unknown argument','unrecognized option','unknown option','unknown feature','unknown config key','unrecognized config key']
    .some(fragment => text.includes(fragment));
}

async function runCodex(prompt, config, signal) {
  const capability = await probeCodexCapabilities(config);
  return new Promise((resolve, reject) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-service-'));
    const schemaPath = path.join(temp, 'review-schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify(outputSchema(config.maxFindings)), { mode: 0o600 });
    const args = buildCodexArgs(schemaPath, config.codexModel);
    const child = spawn(config.codexPath, args, {
      cwd: temp,
      env: filteredEnv(config),
      stdio: ['pipe','pipe','pipe'],
      detached: process.platform !== 'win32'
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let limitExceeded = false;
    const cleanup = () => { try { fs.rmSync(temp, { recursive: true, force: true }); } catch {} };
    const stop = () => {
      if (settled) return;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {}
    };
    const timer = setTimeout(stop, config.reviewTimeoutSeconds * 1000);
    const onAbort = () => stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 6 * 1024 * 1024) { limitExceeded = true; stop(); }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 1024 * 1024) { limitExceeded = true; stop(); }
    });
    child.on('error', error => {
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); cleanup(); reject(error);
    });
    child.on('close', code => {
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      try {
        if (signal?.aborted) return reject(Object.assign(new Error('Review superseded'), { code: 'ESUPERSEDED' }));
        if (limitExceeded) return reject(Object.assign(new Error('Codex output exceeded configured safety limit'), { code: 'ECODEXOUTPUT' }));
        if (code !== 0) {
          const error = new Error(`Codex exited with code ${code}`);
          error.code = compatibilityError(stderr) ? 'ECODEXVERSION' : 'ECODEX';
          error.stderr = stderr.slice(0, 1000);
          return reject(error);
        }
        const text = parseJsonl(stdout);
        let parsed;
        try { parsed = JSON.parse(text); }
        catch { throw Object.assign(new Error('Codex final agent_message is not valid JSON'), { code: 'ECODEXOUTPUT' }); }
        resolve({ parsed, version: capability.version });
      } catch (error) { reject(error); }
      finally { cleanup(); }
    });
    child.stdin.end(prompt);
  });
}

module.exports = {
  runCodex, filteredEnv, parseJsonl, buildCodexArgs, probeCodexCapabilities,
  SAFE_CONFIG_OVERRIDES, REQUIRED_TOP_FLAGS, REQUIRED_EXEC_FLAGS
};
