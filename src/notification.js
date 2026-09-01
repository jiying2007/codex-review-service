'use strict';

const crypto = require('node:crypto');

const { FLOW_EVENTS } = require('./flow-tracking');

const EVENTS = Object.freeze([
  'review.completed',
  'review.blocked',
  'review.failed',
  'service.degraded',
  'service.recovered',
  ...FLOW_EVENTS,
]);
const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
const FEISHU_TOKEN_SKEW_MS = 60_000;
const FEISHU_TOKEN_ERROR_CODES = new Set([99991661, 99991663, 99991668]);
const FEISHU_RETRYABLE_CODES = new Set([90002, 90013, 90014, 99991400]);

function notifyError(message, code = 'ENOTIFY', details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function canonicalUtc(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw notifyError('Notification event time is invalid', 'ENOTIFYEVENT');
  return date.toISOString();
}

function counts(findings = []) {
  const out = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) if (Object.hasOwn(out, finding.severity)) out[finding.severity]++;
  return out;
}

function cardText(value, max = 300) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[<>&`*_~\[\](){}|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cardUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { return ''; }
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash ? url.toString() : '';
}

function notificationSecretEnvName(ref, suffix) {
  return `CODEX_REVIEW_NOTIFY_${String(ref).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${suffix}`;
}

function secretEnvName(ref) { return notificationSecretEnvName(ref, 'WEBHOOK'); }
function signingEnvName(ref) { return notificationSecretEnvName(ref, 'SIGNING_SECRET'); }
function appIdEnvName(ref) { return notificationSecretEnvName(ref, 'APP_ID'); }
function appSecretEnvName(ref) { return notificationSecretEnvName(ref, 'APP_SECRET'); }
function chatIdEnvName(ref) { return notificationSecretEnvName(ref, 'CHAT_ID'); }

function requiredRouteSecret(route, env, envName) {
  const value = String(env[envName] || '').trim();
  if (!value || /[\r\n\0]/.test(value)) {
    throw notifyError(`${envName} is required for notification route ${route.name}`, 'ENOTIFYSECRET');
  }
  return value;
}

function signingSecretFor(route, env = process.env) {
  return route.provider === 'feishu' ? String(env[signingEnvName(route.secretRef)] || '').trim() : '';
}

function feishuSignature(secret, timestamp = Math.floor(Date.now() / 1000)) {
  const sign = crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
  return { timestamp: String(timestamp), sign };
}

function webhookFor(route, env = process.env) {
  const name = secretEnvName(route.secretRef);
  const value = requiredRouteSecret(route, env, name);
  let url;
  try { url = new URL(value); } catch { throw notifyError(`${name} must be a valid HTTPS URL`, 'ENOTIFYSECRET'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw notifyError(`${name} must be a credential-free HTTPS URL`, 'ENOTIFYSECRET');
  }
  const host = url.hostname.toLowerCase();
  if (route.provider === 'feishu' && !['open.feishu.cn', 'open.larksuite.com'].includes(host)) {
    throw notifyError(`${name} must use an official Feishu/Lark bot host`, 'ENOTIFYSECRET');
  }
  if (route.provider === 'wecom' && host !== 'qyapi.weixin.qq.com') {
    throw notifyError(`${name} must use qyapi.weixin.qq.com`, 'ENOTIFYSECRET');
  }
  return value;
}

function feishuAppCredentials(route, env = process.env) {
  const appId = requiredRouteSecret(route, env, appIdEnvName(route.secretRef));
  const appSecret = requiredRouteSecret(route, env, appSecretEnvName(route.secretRef));
  const chatId = requiredRouteSecret(route, env, chatIdEnvName(route.secretRef));
  if (!/^cli_[A-Za-z0-9]+$/.test(appId)) throw notifyError(`${appIdEnvName(route.secretRef)} is invalid`, 'ENOTIFYSECRET');
  if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) throw notifyError(`${chatIdEnvName(route.secretRef)} is invalid`, 'ENOTIFYSECRET');
  return Object.freeze({ appId, appSecret, chatId });
}

function validateRouteCredentials(route, env = process.env) {
  if (route.provider === 'feishu_app') return feishuAppCredentials(route, env);
  return webhookFor(route, env);
}

async function prepareNotificationRoutes(gitlab, config) {
  if (!config.notificationEnabled) return Object.freeze({ ...config, notificationRoutesResolved: Object.freeze([]) });
  const resolved = [];
  for (const route of config.notificationRoutes) {
    const projectIds = new Set(route.projects);
    for (const groupId of route.groups) {
      const page = await gitlab.paginated(`/groups/${encodeURIComponent(groupId)}/projects`, {
        include_subgroups: 'true', archived: 'false', with_merge_requests_enabled: 'true', simple: 'true',
      });
      if (!page?.complete) throw notifyError(`Notification route ${route.name} group ${groupId} discovery incomplete`, 'ENOTIFYROUTE');
      for (const project of page.items || []) {
        const id = Number(project?.id || 0);
        if (Number.isInteger(id) && id > 0) projectIds.add(id);
      }
    }
    if (!route.projects.length && !route.groups.length) for (const id of config.gitlabProjectAllowlist || []) projectIds.add(Number(id));
    for (const id of projectIds) {
      if (config.gitlabProjectAllowlist && !config.gitlabProjectAllowlist.has(Number(id))) {
        throw notifyError(`Notification route ${route.name} includes out-of-scope project ${id}`, 'ENOTIFYROUTE');
      }
    }
    const finalRoute = Object.freeze({ ...route, projectIds: Object.freeze([...projectIds].sort((a, b) => a - b)) });
    validateRouteCredentials(finalRoute);
    resolved.push(finalRoute);
  }
  return Object.freeze({ ...config, notificationRoutesResolved: Object.freeze(resolved) });
}

function eventForReview({ job, mr, snapshot, review, durationMs, topFindings = 3, occurredAt }) {
  const type = review.verdict === 'block' || review.verdict === 'incomplete' ? 'review.blocked' : 'review.completed';
  return Object.freeze({ type, occurredAt: canonicalUtc(occurredAt), projectId: Number(job.project_id), mrIid: Number(job.mr_iid), title: cardText(mr?.title || snapshot?.title || '', 300), url: cardUrl(mr?.web_url || ''), author: cardText(mr?.author?.name || mr?.author?.username || '', 120), sourceBranch: cardText(snapshot?.sourceBranch || job.source_branch || '', 200), targetBranch: cardText(snapshot?.targetBranch || mr?.target_branch || '', 200), headSha: cardText(snapshot?.headSha || job.head_sha || '', 64), verdict: cardText(review.verdict || '', 40), coverageComplete: review.coverageComplete !== false, findingCounts: counts(review.findings), findingCount: Number(review.findings?.length || 0), topFindings: (review.findings || []).slice(0, topFindings).map(finding => ({ severity: cardText(finding.severity, 20), title: cardText(finding.title, 180), file: cardText(finding.file, 300), line: Number(finding.line || 0) })), durationMs: Number(durationMs || 0) });
}

function eventForFailure(job, code) {
  return Object.freeze({ type: 'review.failed', occurredAt: canonicalUtc(), projectId: Number(job.project_id), mrIid: Number(job.mr_iid), title: '', url: '', author: '', sourceBranch: cardText(job.source_branch || '', 200), targetBranch: '', headSha: cardText(job.head_sha || '', 64), verdict: 'failed', coverageComplete: false, findingCounts: counts([]), findingCount: 0, topFindings: [], durationMs: 0, errorCode: cardText(code || 'EUNKNOWN', 80) });
}

function systemEvent(type, details = {}) {
  if (!EVENTS.includes(type) || !type.startsWith('service.')) throw notifyError(`Unsupported system notification event: ${type}`, 'ENOTIFYEVENT');
  return Object.freeze({ type, occurredAt: canonicalUtc(), projectId: 0, mrIid: 0, title: 'Codex Review Service', url: '', author: '', sourceBranch: '', targetBranch: '', headSha: '', verdict: type === 'service.recovered' ? 'recovered' : 'degraded', coverageComplete: false, findingCounts: counts([]), findingCount: 0, topFindings: [], durationMs: 0, details: Object.freeze(Object.fromEntries(Object.entries(details).map(([key, value]) => [cardText(key, 80), cardText(value, 200)]))) });
}

function planNotificationActions(config, event, runKey) {
  if (!config.notificationEnabled) return [];
  const actions = [];
  for (const route of config.notificationRoutesResolved || []) {
    const events = route.events.length ? route.events : config.notificationEvents;
    if (!events.includes(event.type)) continue;
    if (!event.type.startsWith('service.') && !route.projectIds.includes(Number(event.projectId))) continue;
    actions.push({ routeName: route.name, provider: route.provider, secretRef: route.secretRef, eventType: event.type, dedupeKey: `${runKey}:${route.name}:${event.type}`, payload: event });
  }
  return actions;
}

function titleFor(event) {
  if (event.type === 'review.blocked') return '🔴 Codex Review Blocked';
  if (event.type === 'review.failed') return '⚠️ Codex Review Failed';
  if (event.type === 'service.degraded') return '⚠️ Codex Review Service Degraded';
  if (event.type === 'service.recovered') return '🟢 Codex Review Service Recovered';
  if (event.type === 'gitlab.pipeline.failed') return '🔴 GitLab Pipeline Failed';
  if (event.type === 'gitlab.pipeline.succeeded') return '🟢 GitLab Pipeline Succeeded';
  if (event.type === 'gitlab.pipeline.canceled' || event.type === 'gitlab.pipeline.skipped') return '⚪ GitLab Pipeline Terminal';
  if (event.type === 'gitlab.mr.merged') return '🟢 GitLab MR Merged';
  if (event.type.startsWith('gitlab.mr.')) return 'GitLab MR Lifecycle';
  if (event.type.startsWith('gitlab.tag.')) return 'GitLab Tag Lifecycle';
  if (event.type.startsWith('gitlab.branch.')) return 'GitLab Branch Lifecycle';
  if (event.type === 'gitlab.push.committed') return '🔵 GitLab Code Push';
  return '🟢 Codex Review Completed';
}

function summaryLines(event) {
  const lines = [];
  if (String(event.type || '').startsWith('gitlab.')) {
    if (event.projectId) lines.push(`Project: ${event.projectId}`);
    if (event.occurredAt) lines.push(`Time (UTC): ${cardText(event.occurredAt, 40)}`);
    if (event.flowKind === 'pipeline') { lines.push(`Pipeline: #${cardText(event.externalId, 40)}`, `Ref: ${cardText(event.ref || '-', 200)}`, `Status: ${cardText(event.status, 40)}`); if (event.source) lines.push(`Source: ${cardText(event.source, 80)}`); }
    else if (event.flowKind === 'merge_request') { lines.push(`MR: !${event.mrIid} ${cardText(event.title || '', 180)}`.trim(), `Status: ${cardText(event.status, 40)}`); if (event.sourceBranch || event.targetBranch) lines.push(`Branches: ${cardText(event.sourceBranch || '-', 120)} → ${cardText(event.targetBranch || '-', 120)}`); }
    else if (event.flowKind === 'commit_push') { lines.push(`Branch: ${cardText(event.ref || '-', 200)}`, `Commits: ${Number(event.commitCount || 0)}`); if (event.beforeSha && event.afterSha) lines.push(`Range: ${cardText(event.beforeSha, 64).slice(0, 12)} → ${cardText(event.afterSha, 64).slice(0, 12)}`); }
    else lines.push(`${event.flowKind === 'tag' ? 'Tag' : 'Branch'}: ${cardText(event.ref || event.externalId, 200)}`, `Status: ${cardText(event.status, 40)}`);
    if (event.actor) lines.push(`Actor: ${cardText(event.actor, 120)}`);
    if (event.durationMs) lines.push(`Duration: ${(event.durationMs / 1000).toFixed(1)}s`);
    return lines;
  }
  const findingCounts = event.findingCounts || counts([]);
  if (event.projectId) lines.push(`Project: ${event.projectId}`, `MR: !${event.mrIid}${event.title ? ` ${event.title}` : ''}`);
  if (event.occurredAt) lines.push(`Time (UTC): ${event.occurredAt}`);
  lines.push(`Verdict: ${event.verdict}`);
  if (event.errorCode) lines.push(`Error: ${event.errorCode}`);
  if (event.headSha) lines.push(`HEAD: ${event.headSha.slice(0, 12)}`);
  if (event.projectId) lines.push(`Findings: Critical ${findingCounts.critical} · High ${findingCounts.high} · Medium ${findingCounts.medium} · Low ${findingCounts.low}`);
  if (event.durationMs) lines.push(`Duration: ${(event.durationMs / 1000).toFixed(1)}s`);
  return lines;
}

function feishuPayload(event, signature = null) {
  const elements = [{ tag: 'div', text: { tag: 'lark_md', content: summaryLines(event).join('\n') } }];
  if (event.commits?.length) { const details = event.commits.map((commit, index) => `${index + 1}. ${cardText(commit.shortSha || commit.sha, 12)}${commit.message ? ` · ${cardText(commit.message, 160)}` : ''}${commit.author ? ` · ${cardText(commit.author, 80)}` : ''}`); if (event.omittedCommitCount) details.push(`… +${Number(event.omittedCommitCount)} omitted`); elements.push({ tag: 'div', text: { tag: 'lark_md', content: `Commits\n${details.join('\n')}` } }); }
  if (event.jobs?.length) elements.push({ tag: 'div', text: { tag: 'lark_md', content: `Failed jobs\n${event.jobs.map((job, index) => `${index + 1}. ${cardText(job.stage || '-', 80)} · ${cardText(job.name, 120)} · ${cardText(job.failureReason || job.status, 160)}`).join('\n')}` } });
  if (event.topFindings?.length) elements.push({ tag: 'div', text: { tag: 'lark_md', content: `Top findings\n${event.topFindings.map((finding, index) => `${index + 1}. ${finding.severity.toUpperCase()} · ${finding.title} (${finding.file}:${finding.line})`).join('\n')}` } });
  if (event.url) elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: String(event.type || '').startsWith('gitlab.') ? 'View GitLab' : 'View Merge Request' }, url: event.url, type: 'primary' }] });
  return { ...(signature || {}), msg_type: 'interactive', card: { header: { title: { tag: 'plain_text', content: titleFor(event) } }, elements } };
}

function wecomPayload(event) {
  const horizontal_content_list = summaryLines(event).filter(line => !line.startsWith('Project: ')).slice(0, 6).map(line => { const index = line.indexOf(':'); return { keyname: cardText(index > 0 ? line.slice(0, index) : 'Status', 5), value: cardText(index > 0 ? line.slice(index + 1).trim() : line, 26) }; });
  const card = { card_type: 'text_notice', source: { desc: 'Codex Review' }, main_title: { title: cardText(titleFor(event), 26), desc: cardText(event.title || '', 30) }, horizontal_content_list, card_action: { type: 1, url: event.url || 'https://work.weixin.qq.com/' } };
  if (event.commits?.length) card.sub_title_text = cardText(event.commits.map((commit, index) => `${index + 1}. ${cardText(commit.shortSha || commit.sha, 12)}${commit.message ? ` ${cardText(commit.message, 80)}` : ''}`).concat(event.omittedCommitCount ? [`+${Number(event.omittedCommitCount)} omitted`] : []).join(' · '), 112);
  else if (event.jobs?.length) card.sub_title_text = cardText(event.jobs.map((job, index) => `${index + 1}. ${job.stage || '-'}/${job.name}: ${job.failureReason || job.status}`).join(' · '), 112);
  else if (event.topFindings?.length) card.sub_title_text = cardText(event.topFindings.map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.title} ${finding.file}:${finding.line}`).join(' · '), 112);
  if (event.url) card.jump_list = [{ type: 1, url: event.url, title: String(event.type || '').startsWith('gitlab.') ? 'View GitLab' : 'View MR' }];
  return { msgtype: 'template_card', template_card: card };
}

function payloadFor(provider, event, route = null, env = process.env) {
  if (provider === 'feishu') { const secret = route ? signingSecretFor(route, env) : ''; return feishuPayload(event, secret ? feishuSignature(secret) : null); }
  if (provider === 'wecom') return wecomPayload(event);
  throw notifyError(`Unsupported webhook notification provider: ${provider}`, 'ENOTIFYPROVIDER');
}

async function postJson(url, payload, timeoutMs, { headers = {}, fetchImpl = fetch, provider = 'notification' } = {}) {
  let response;
  try { response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) }); }
  catch (cause) { throw notifyError(`${provider} network request failed`, 'ENOTIFYNETWORK', { cause, retryable: true }); }
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) throw notifyError(`${provider} HTTP ${response.status}`, 'ENOTIFYHTTP', { status: response.status, body, retryable: [408, 409, 425, 429].includes(response.status) || response.status >= 500 });
  return body;
}

async function postWebhook(url, payload, timeoutMs, options = {}) {
  const body = await postJson(url, payload, timeoutMs, { ...options, provider: 'notification' });
  if (Object.hasOwn(body, 'errcode') && Number(body.errcode) !== 0) throw notifyError(`WeCom rejected notification: ${body.errcode}`, 'ENOTIFYREMOTE', { providerCode: Number(body.errcode), retryable: false });
  if ((Object.hasOwn(body, 'code') && Number(body.code) !== 0) || (Object.hasOwn(body, 'StatusCode') && Number(body.StatusCode) !== 0)) throw notifyError('Feishu rejected notification', 'ENOTIFYREMOTE', { providerCode: Number(body.code ?? body.StatusCode), retryable: false });
  return body;
}

function feishuApiError(operation, body) {
  const providerCode = Number(body?.code);
  return notifyError(`Feishu ${operation} rejected request: ${Number.isFinite(providerCode) ? providerCode : 'unknown'}`, 'EFEISHUAPI', { providerCode, retryable: FEISHU_RETRYABLE_CODES.has(providerCode) });
}

function isFeishuTokenError(error) {
  return error?.status === 401 || FEISHU_TOKEN_ERROR_CODES.has(Number(error?.providerCode));
}

class WebhookProvider {
  constructor({ env, fetchImpl }) { this.env = env; this.fetchImpl = fetchImpl; }
  validate(route) { webhookFor(route, this.env); }
  async send(route, event, timeoutMs) { const body = await postWebhook(webhookFor(route, this.env), payloadFor(route.provider, event, route, this.env), timeoutMs, { fetchImpl: this.fetchImpl }); return { remoteId: `${route.provider}:${route.name}`, body }; }
}

class FeishuAppProvider {
  constructor({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) { this.env = env; this.fetchImpl = fetchImpl; this.now = now; this.tokens = new Map(); }
  validate(route) { feishuAppCredentials(route, this.env); }
  tokenKey(credentials) { return `${credentials.appId}:${credentials.appSecret}`; }
  async tenantAccessToken(route, timeoutMs, forceRefresh = false) {
    const credentials = feishuAppCredentials(route, this.env), key = this.tokenKey(credentials), cached = this.tokens.get(key);
    if (!forceRefresh && cached && cached.expiresAt > this.now()) return { credentials, token: cached.token };
    const body = await postJson(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, { app_id: credentials.appId, app_secret: credentials.appSecret }, timeoutMs, { fetchImpl: this.fetchImpl, provider: 'Feishu tenant token' });
    if (Number(body?.code) !== 0 || !String(body?.tenant_access_token || '').trim()) throw feishuApiError('tenant token', body);
    const expireSeconds = Number(body.expire ?? body.expires_in ?? 7200);
    const expiresAt = this.now() + Math.max(1, expireSeconds * 1000 - FEISHU_TOKEN_SKEW_MS);
    const token = String(body.tenant_access_token).trim();
    this.tokens.set(key, { token, expiresAt });
    return { credentials, token };
  }
  async sendWithToken(credentials, token, event, timeoutMs) {
    const body = await postJson(`${FEISHU_API_BASE}/im/v1/messages?receive_id_type=chat_id`, { receive_id: credentials.chatId, msg_type: 'interactive', content: JSON.stringify(feishuPayload(event).card) }, timeoutMs, { headers: { authorization: `Bearer ${token}` }, fetchImpl: this.fetchImpl, provider: 'Feishu message' });
    if (Number(body?.code) !== 0) throw feishuApiError('message', body);
    const remoteId = String(body?.data?.message_id || '').trim();
    if (!remoteId) throw notifyError('Feishu message response omitted message_id', 'EFEISHUAPI', { providerCode: 0, retryable: true });
    return { remoteId, body };
  }
  async send(route, event, timeoutMs) {
    let session = await this.tenantAccessToken(route, timeoutMs);
    try { return await this.sendWithToken(session.credentials, session.token, event, timeoutMs); }
    catch (error) {
      if (!isFeishuTokenError(error)) throw error;
      this.tokens.delete(this.tokenKey(session.credentials));
      session = await this.tenantAccessToken(route, timeoutMs, true);
      return this.sendWithToken(session.credentials, session.token, event, timeoutMs);
    }
  }
}

function createNotificationProviders(options = {}) {
  const webhook = new WebhookProvider(options);
  return new Map([['feishu', webhook], ['wecom', webhook], ['feishu_app', new FeishuAppProvider(options)]]);
}

function retryableNotification(error) {
  if (!error) return true;
  if (typeof error.retryable === 'boolean') return error.retryable;
  if (error.code === 'ENOTIFYHTTP') { const status = Number(error.status); return [408, 409, 425, 429].includes(status) || status >= 500; }
  return error.code === 'ENOTIFYNETWORK';
}

function notificationDelay(config, item) {
  const base = Math.min(config.notificationRetryMaxDelayMs, config.notificationRetryBaseDelayMs * (2 ** Math.max(0, item.attempt - 1)));
  return Math.round(base * (0.85 + Math.random() * 0.3));
}

class Notifier {
  constructor({ config, store, logger = console, env = process.env, fetchImpl = fetch, now } = {}) {
    this.config = config; this.store = store; this.logger = logger; this.env = env; this.stopping = false; this.workers = [];
    this.routes = new Map((config.notificationRoutesResolved || []).map(route => [route.name, route]));
    this.providers = createNotificationProviders({ env, fetchImpl, now });
  }
  refreshConfig(config) { this.config = config; this.routes = new Map((config.notificationRoutesResolved || []).map(route => [route.name, route])); }
  async execute(item) { const route = this.routes.get(item.route_name); if (!route) throw notifyError(`Notification route disappeared: ${item.route_name}`, 'ENOTIFYROUTE'); const provider = this.providers.get(route.provider); if (!provider) throw notifyError(`Unsupported notification provider: ${route.provider}`, 'ENOTIFYPROVIDER'); return provider.send(route, item.payload, this.config.notificationRequestTimeoutMs); }
  async process(item) { try { const result = await this.execute(item); this.store.finishNotification(item.id, result.remoteId); this.logger.info?.({ event: 'notification_delivered', outboxId: item.id, route: item.route_name, provider: item.provider, eventType: item.event_type, attempt: item.attempt }); } catch (error) { const retry = item.attempt < this.config.maxNotificationAttempts && retryableNotification(error) && !this.stopping; this.logger.warn?.({ event: retry ? 'notification_retry' : 'notification_failed', outboxId: item.id, route: item.route_name, provider: item.provider, eventType: item.event_type, attempt: item.attempt, code: error.code || 'ENOTIFY', providerCode: error.providerCode ?? null, status: error.status || null }); if (retry) this.store.retryNotification(item.id, error.code || 'ENOTIFY', notificationDelay(this.config, item)); else this.store.failNotification(item.id, error.code || 'ENOTIFY'); } }
  async workerLoop() { while (!this.stopping) { const item = this.store.claimNotification(); if (!item) { await sleep(this.config.notificationPollIntervalMs); continue; } await this.process(item); } }
  start() { if (!this.config.notificationEnabled || this.workers.length) return this.workers; this.workers = Array.from({ length: this.config.notificationConcurrency }, () => this.workerLoop()); return this.workers; }
  async stop() { this.stopping = true; await Promise.allSettled(this.workers); }
}

module.exports = { EVENTS, FEISHU_API_BASE, Notifier, WebhookProvider, FeishuAppProvider, createNotificationProviders, prepareNotificationRoutes, eventForReview, eventForFailure, systemEvent, planNotificationActions, payloadFor, feishuPayload, wecomPayload, cardText, cardUrl, notificationSecretEnvName, secretEnvName, signingEnvName, appIdEnvName, appSecretEnvName, chatIdEnvName, signingSecretFor, feishuSignature, webhookFor, feishuAppCredentials, retryableNotification, notificationDelay, postJson, postWebhook, feishuApiError, isFeishuTokenError };
