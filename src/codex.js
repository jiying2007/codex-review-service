'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { outputSchema } = require('./review');

function filteredEnv(config) {
  const env = {};
  for (const key of ['PATH','HOME','USERPROFILE','LANG','LC_ALL','TMPDIR','TEMP','TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (config.codexHome) env.CODEX_HOME = config.codexHome;
  if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  return env;
}

function parseJsonl(stdout) {
  let lastAgentMessage = '';
  const errors = [];
  for (const line of String(stdout || '').split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error('Codex --json returned invalid JSONL'); }
    if (event?.type === 'item.completed' && event?.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      lastAgentMessage = event.item.text;
    }
    if (event?.type === 'error') errors.push(event.message || event.error?.message || 'Codex error');
    if (event?.type === 'turn.failed') errors.push(event.error?.message || event.message || 'Codex turn failed');
  }
  if (!lastAgentMessage && errors.length) throw new Error(errors.join('; '));
  if (!lastAgentMessage) throw new Error('Codex JSONL did not contain a final agent_message');
  return lastAgentMessage.trim();
}

function runCodex(prompt, config, signal) {
  return new Promise((resolve, reject) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-service-'));
    const schemaPath = path.join(temp, 'review-schema.json');
    fs.writeFileSync(schemaPath, JSON.stringify(outputSchema(config.maxFindings)), { mode: 0o600 });
    const args = ['exec','--json','--sandbox','read-only','--skip-git-repo-check','--output-schema',schemaPath];
    if (config.codexModel) args.push('--model', config.codexModel);
    args.push('-');
    const child = spawn(config.codexPath, args, {
      cwd: temp,
      env: filteredEnv(config),
      stdio: ['pipe','pipe','pipe'],
      detached: process.platform !== 'win32'
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
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
      if (Buffer.byteLength(stdout) > 6 * 1024 * 1024) stop();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 1024 * 1024) stop();
    });
    child.on('error', error => {
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); cleanup(); reject(error);
    });
    child.on('close', code => {
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      try {
        if (signal?.aborted) return reject(Object.assign(new Error('Review superseded'), { code: 'ESUPERSEDED' }));
        if (code !== 0) return reject(new Error(`Codex exited with code ${code}: ${stderr.slice(0, 1000)}`));
        const text = parseJsonl(stdout);
        const parsed = JSON.parse(text);
        resolve({ parsed, version: 'cli' });
      } catch (error) { reject(error); }
      finally { cleanup(); }
    });
    child.stdin.end(prompt);
  });
}

module.exports = { runCodex, filteredEnv, parseJsonl };
