'use strict';

const { loadConfig, notificationRouteWarnings } = require('./config');
const { Store, SCHEMA_VERSION } = require('./db');
const { GitLabClient } = require('./gitlab');
const { ProjectScopeManager } = require('./project-scope');
const { probeCodexRuntime } = require('./codex');
const { contract } = require('./product-contract');

async function runDoctor({ loadConfigFn = loadConfig } = {}) {
  const checks = { product: { ok: true, ...contract, node: process.version } };
  let store;
  try {
    const config = loadConfigFn();
    const routeWarnings = notificationRouteWarnings(config.notificationRoutes || []);
    checks.config = { ok: config.configSchemaVersion === contract.configSchemaVersion, file: config.configFilePath, schemaVersion: config.configSchemaVersion, expectedSchemaVersion: contract.configSchemaVersion, deployment: config.runnerMode === 'isolated' ? 'hardened' : 'standard' };
    store = new Store(config.dbPath);
    const quick = store.db.prepare('PRAGMA quick_check').get()?.quick_check || 'unknown', foreign = store.db.prepare('PRAGMA foreign_key_check').all();
    checks.database = { ok: store.ping() && store.schemaVersion() === SCHEMA_VERSION && SCHEMA_VERSION === contract.databaseSchemaVersion && store.synchronousMode() === 2 && quick === 'ok' && !foreign.length, schemaVersion: store.schemaVersion(), expectedSchemaVersion: contract.databaseSchemaVersion, synchronous: store.synchronousMode(), quickCheck: quick, foreignKeyViolations: foreign.length, publicationDepth: store.publicationDepth(), notificationDepth: store.notificationDepth() };
    try {
      const runtime = await probeCodexRuntime(config, true);
      checks.codex = { ok: true, mode: config.runnerMode, version: runtime.codexVersion || runtime.version || 'unknown', versionMatched: runtime.versionMatched !== false, versionPolicy: config.codexVersionPolicy, provider: runtime.provider?.mode || config.codexProviderMode, endpointHost: runtime.provider?.endpointHost || '', liveProbeMs: runtime.durationMs || 0 };
      if (config.codexVersionPolicy === 'warn' && runtime.versionMatched === false) checks.codex.warning = 'Codex version does not match codex.allowedVersionPattern';
    } catch (error) { checks.codex = { ok: false, code: error.code || 'ECODEX' }; }
    try {
      const gitlab = new GitLabClient(config), version = await gitlab.getVersion(), capabilities = await gitlab.getCapabilities(), scope = new ProjectScopeManager(gitlab, config), resolved = await scope.refresh();
      checks.gitlab = { ok: true, version: version?.version || 'unknown', minimumVersion: contract.minimumGitLabVersion, recommendedPolicy: contract.recommendedGitLabPolicy, profile: capabilities.profile, diffCompleteness: capabilities.diffCompleteness, webhookAuth: capabilities.webhookAuth, webhookReplayWindow: capabilities.webhookReplayWindow, webhookInstanceHeader: capabilities.webhookInstanceHeader, circuit: gitlab.health().circuit };
      checks.projectScope = { ok: resolved.healthy, mode: resolved.mode, explicitProjects: resolved.explicitProjects, groups: resolved.groups, discoveredProjects: resolved.discoveredProjects, totalProjects: resolved.totalProjects };
    } catch (error) { checks.gitlab = { ok: false, code: error.code || 'EGITLAB', status: error.status || null, version: error.version || null, minimumVersion: error.minimumVersion || contract.minimumGitLabVersion }; checks.projectScope = { ok: false, code: error.code || 'EPROJECTSCOPE' }; }
    checks.publication = { ok: true, mode: 'durable-outbox', publishers: config.publisherConcurrency, maxAttempts: config.maxPublishAttempts };
    checks.notifications = { ok: true, enabled: config.notificationEnabled, notifiers: config.notificationEnabled ? config.notificationConcurrency : 0, maxAttempts: config.maxNotificationAttempts, routeWarnings };
    checks.context = { ok: true, enabled: config.contextEnabled, maxBytes: config.maxContextBytes, maxFiles: config.maxContextFiles };
    checks.budget = { ok: true, mrMaxTokens: config.mrMaxTokenBudget, projectDailyTokens: config.projectDailyTokenBudget };
  } catch (error) { checks.config = { ok: false, code: error.code || 'ECONFIG', message: error.message }; }
  finally { try { store?.close(); } catch {} }
  return { ok: Object.values(checks).every(check => check.ok !== false), checks };
}

async function main() { const result = await runDoctor(); process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); if (!result.ok) process.exitCode = 1; }
if (require.main === module) main().catch(error => { process.stderr.write(`${JSON.stringify({ ok: false, error: error.code || 'EDOCTOR' })}\n`); process.exitCode = 1; });

module.exports = { main, runDoctor };
