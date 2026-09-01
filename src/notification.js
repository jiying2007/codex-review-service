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
const FEISHU_MIN_REQUEST_INTERVAL_MS = 50;
const FEISHU_CARD_MAX_BYTES = 28_000;
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

function wildcardMatch(value, patterns = [], insensitive = false) {
  if (!patterns.length) return true;
  const input = insensitive ? String(value || '').toLowerCase() : String(value || '');
  return patterns.some(pattern => { const source = (insensitive ? String(pattern).toLowerCase() : String(pattern)).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'); return new RegExp(`^${source}$`).test(input); });
}

function routeMatchesEvent(route, event) {
  const branch = event.sourceBranch || event.ref || '';
  if (!wildcardMatch(branch, route.branches || [])) return false;
  if (route.authors?.length && !wildcardMatch(event.author || event.actor || '', route.authors, true)) return false;
  if (route.reviewers?.length && !(event.reviewers || []).some(value => wildcardMatch(value, route.reviewers, true))) return false;
  if (route.severities?.length) { const countsBySeverity = event.findingCounts || {}; if (!route.severities.some(severity => Number(countsBySeverity[severity] || 0) > 0)) return false; }
  return true;
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
  return Object.freeze({ type, occurredAt: canonicalUtc(occurredAt), projectId: Number(job.project_id), mrIid: Number(job.mr_iid), title: cardText(mr?.title || snapshot?.title || '', 300), url: cardUrl(mr?.web_url || ''), author: cardText(mr?.author?.name || mr?.author?.username || '', 120), reviewers: Object.freeze((mr?.reviewers || []).map(item => cardText(item?.username || item?.name || '', 120)).filter(Boolean)), sourceBranch: cardText(snapshot?.sourceBranch || job.source_branch || '', 200), targetBranch: cardText(snapshot?.targetBranch || mr?.target_branch || '', 200), headSha: cardText(snapshot?.headSha || job.head_sha || '', 64), verdict: cardText(review.verdict || '', 40), coverageComplete: review.coverageComplete !== false, findingCounts: counts(review.findings), findingCount: Number(review.findings?.length || 0), topFindings: (review.findings || []).slice(0, topFindings).map(finding => ({ severity: cardText(finding.severity, 20), title: cardText(finding.title, 180), file: cardText(finding.file, 300), line: Number(finding.line || 0), impact: cardText(finding.description || '', 200), url: cardUrl(finding.url || '') })), durationMs: Number(durationMs || 0) });
}

function eventForFailure(job, code) {
  return Object.freeze({ type: 'review.failed', occurredAt: canonicalUtc(), projectId: Number(job.project_id), mrIid: Number(job.mr_iid), title: '', url: '', author: '', sourceBranch: cardText(job.source_branch || '', 200), targetBranch: '', headSha: cardText(job.head_sha || '', 64), verdict: 'failed', coverageComplete: false, findingCounts: counts([]), findingCount: 0, topFindings: [], durationMs: 0, errorCode: cardText(code || 'EUNKNOWN', 80) });
}

function eventForReviewStarted(job, mr) {
  return Object.freeze({ type: 'review.started', occurredAt: canonicalUtc(), projectId: Number(job.project_id), mrIid: Number(job.mr_iid), title: cardText(mr?.title || '', 300), url: cardUrl(mr?.web_url || ''), author: cardText(mr?.author?.name || mr?.author?.username || '', 120), reviewers:Object.freeze((mr?.reviewers||[]).map(item=>cardText(item?.username||item?.name||'',120)).filter(Boolean)), sourceBranch: cardText(job.source_branch || mr?.source_branch || '', 200), targetBranch: cardText(mr?.target_branch || '', 200), headSha: cardText(job.head_sha || '', 64), verdict: 'running', findingCounts: counts([]), findingCount: 0, topFindings: [], durationMs: 0 });
}

function planStatusCardActions(config, event, jobId) {
  if (!config.notificationEnabled) return [];
  return (config.notificationRoutesResolved || []).filter(route => route.provider === 'feishu_app' && route.statusCard && route.projectIds.includes(Number(event.projectId)) && routeMatchesEvent(route,event)).map(route => ({ routeName: route.name, provider: route.provider, secretRef: route.secretRef, eventType: event.type, dedupeKey: `job:${jobId}:${route.name}:status-card`, statusCardJobId: Number(jobId), payload: { ...event, _language: route.language || 'zh-CN', _diagnosticsUrl: cardUrl(route.diagnosticsUrl), _operationType:'status_create', _statusCardOperation: 'create', _statusCardJobId: Number(jobId) } }));
}

function systemEvent(type, details = {}) {
  if (!EVENTS.includes(type) || !type.startsWith('service.')) throw notifyError(`Unsupported system notification event: ${type}`, 'ENOTIFYEVENT');
  return Object.freeze({ type, occurredAt: canonicalUtc(), projectId: 0, mrIid: 0, title: 'Codex Review Service', url: '', author: '', sourceBranch: '', targetBranch: '', headSha: '', verdict: type === 'service.recovered' ? 'recovered' : 'degraded', coverageComplete: false, findingCounts: counts([]), findingCount: 0, topFindings: [], durationMs: 0, details: Object.freeze(Object.fromEntries(Object.entries(details).map(([key, value]) => [cardText(key, 80), cardText(value, 200)]))) });
}

function planNotificationActions(config, event, runKey, statusCardJobId = null) {
  if (!config.notificationEnabled) return [];
  if (!statusCardJobId) statusCardJobId = Number(String(runKey || '').match(/^(?:run|job):(\d+)/)?.[1] || 0) || null;
  const actions = [];
  for (const route of config.notificationRoutesResolved || []) {
    const events = route.events.length ? route.events : config.notificationEvents;
    const statusCardTerminal=route.provider==='feishu_app'&&route.statusCard&&['review.completed','review.blocked','review.failed'].includes(event.type);
    if (!events.includes(event.type)&&!statusCardTerminal) continue;
    if (!event.type.startsWith('service.') && !route.projectIds.includes(Number(event.projectId))) continue;
    if (!routeMatchesEvent(route,event)) continue;
    const useStatusCard = statusCardJobId && route.provider === 'feishu_app' && route.statusCard && String(event.type).startsWith('review.');
    const aggregateUntil=(event.type==='gitlab.push.committed'||String(event.type).startsWith('gitlab.pipeline.'))?new Date(Date.now()+30000).toISOString():'';
    const aggregateKey=event.mrIid?`change:${event.projectId}:${event.mrIid}:${route.name}`:event.type==='gitlab.push.committed'?`push:${event.projectId}:${event.ref||'-'}:${route.name}`:'';
    const localized={...event,_language:route.language||'zh-CN',_diagnosticsUrl:cardUrl(route.diagnosticsUrl),_operationType:useStatusCard?'status_update':'one_shot',...(aggregateKey?{_aggregateKey:aggregateKey}:{}),...(aggregateUntil?{_aggregateUntil:aggregateUntil}:{})};
    actions.push({ routeName: route.name, provider: route.provider, secretRef: route.secretRef, eventType: event.type, dedupeKey: `${runKey}:${route.name}:${event.type}`, statusCardJobId: useStatusCard ? Number(statusCardJobId) : null, payload: useStatusCard ? { ...localized, _statusCardOperation: 'update', _statusCardJobId: Number(statusCardJobId) } : localized });
  }
  return actions;
}

function titleFor(event) {
  const zh=event._language!=='en',titles=zh?{'review.started':'🟡 Codex 审查中','review.blocked':'🔴 Codex 审查需处理','review.failed':'⚠️ Codex 审查失败','service.degraded':'⚠️ Codex Review 服务降级','service.recovered':'🟢 Codex Review 服务恢复','gitlab.pipeline.failed':'🔴 GitLab 流水线失败','gitlab.pipeline.succeeded':'🟢 GitLab 流水线成功','gitlab.pipeline.canceled':'⚪ GitLab 流水线取消','gitlab.pipeline.skipped':'⚪ GitLab 流水线跳过','gitlab.mr.merged':'🟢 GitLab 合并请求已合并','gitlab.mr.opened':'🔵 GitLab 合并请求已打开','gitlab.mr.closed':'⚪ GitLab 合并请求已关闭','gitlab.tag.created':'🟢 GitLab Tag 已创建','gitlab.tag.deleted':'⚪ GitLab Tag 已删除','gitlab.branch.created':'🔵 GitLab 分支已创建','gitlab.branch.deleted':'⚪ GitLab 分支已删除','gitlab.push.committed':'🔵 GitLab 代码推送','review.completed':'🟢 Codex 审查通过'}:{'review.started':'🟡 Codex Review Running','review.blocked':'🔴 Codex Review Blocked','review.failed':'⚠️ Codex Review Failed','service.degraded':'⚠️ Codex Review Service Degraded','service.recovered':'🟢 Codex Review Service Recovered','gitlab.pipeline.failed':'🔴 GitLab Pipeline Failed','gitlab.pipeline.succeeded':'🟢 GitLab Pipeline Succeeded','gitlab.pipeline.canceled':'⚪ GitLab Pipeline Canceled','gitlab.pipeline.skipped':'⚪ GitLab Pipeline Skipped','gitlab.mr.merged':'🟢 GitLab MR Merged','gitlab.mr.opened':'🔵 GitLab MR Opened','gitlab.mr.closed':'⚪ GitLab MR Closed','gitlab.tag.created':'🟢 GitLab Tag Created','gitlab.tag.deleted':'⚪ GitLab Tag Deleted','gitlab.branch.created':'🔵 GitLab Branch Created','gitlab.branch.deleted':'⚪ GitLab Branch Deleted','gitlab.push.committed':'🔵 GitLab Code Push','review.completed':'🟢 Codex Review Completed'};
  return titles[event.type]||titles['review.completed'];
}

function headerTemplateFor(event) {
  if (event.type === 'review.started') return 'yellow';
  if (event.type === 'review.blocked' || event.type === 'gitlab.pipeline.failed') return 'red';
  if (event.type === 'review.failed' || event.type === 'service.degraded') return 'orange';
  if (event.type === 'gitlab.pipeline.canceled' || event.type === 'gitlab.pipeline.skipped') return 'grey';
  if (event.type === 'gitlab.push.committed') return 'blue';
  return 'green';
}

function verdictLabel(event) {
  const verdict = String(event.verdict || '').toLowerCase(),en=event._language==='en';
  if (event.type === 'review.started' || verdict === 'running') return en?'Running':'审查中';
  if (event.type === 'review.blocked' || verdict === 'block' || verdict === 'incomplete') return en?'Needs attention':'需处理';
  if (event.type === 'review.failed' || verdict === 'failed') return en?'Failed':'执行失败';
  if (event.type === 'service.degraded' || verdict === 'degraded') return en?'Degraded':'服务降级';
  if (event.type === 'service.recovered' || verdict === 'recovered') return en?'Recovered':'服务已恢复';
  if (verdict === 'pass') return en?'Pass':'通过';
  return cardText(event.status || event.verdict || '已完成', 40) || '已完成';
}

function feishuFields(event) {
  const en=event._language==='en',field = (label, value, isShort = true) => ({ is_short: isShort, text: { tag: 'lark_md', content: `**${label}**\n${cardText(value, isShort ? 100 : 220) || '-'}` } });
  if (String(event.type || '').startsWith('gitlab.')) {
    if (event.flowKind === 'pipeline') return [field('Pipeline', `#${event.externalId || '-'}`), field(en?'Status':'状态', event.status), field('Ref', event.ref), field(en?'Source':'来源', event.source || '-')];
    if (event.flowKind === 'merge_request') {
      const out = [field('MR', `!${event.mrIid || '-'}`), field(en?'Status':'状态', event.status)];
      if (event.sourceBranch || event.targetBranch) out.push(field(en?'Branch':'分支', `${event.sourceBranch || '-'} → ${event.targetBranch || '-'}`, false));
      if (event.actor) out.push(field(en?'Actor':'操作者', event.actor));
      return out;
    }
    if (event.flowKind === 'commit_push') {
      const out = [field(en?'Branch':'分支', event.ref), field(en?'Commits':'提交数', String(Number(event.commitCount || 0)))];
      if (event.beforeSha && event.afterSha) out.push(field(en?'Range':'范围', `${cardText(event.beforeSha, 12)} → ${cardText(event.afterSha, 12)}`, false));
      if (event.actor) out.push(field(en?'Pusher':'推送者', event.actor));
      return out;
    }
    return [field(event.flowKind === 'tag' ? 'Tag' : en?'Branch':'分支', event.ref || event.externalId), field(en?'Status':'状态', event.status), ...(event.actor ? [field(en?'Actor':'操作者', event.actor)] : [])];
  }
  const findingCounts = event.findingCounts || counts([]);
  const fields = [];
  if (event.projectId) fields.push({ is_short: true, text: { tag: 'lark_md', content: `**MR**\n!${Number(event.mrIid) || '-'}` } });
  fields.push({ is_short: true, text: { tag: 'lark_md', content: `**${en?'Verdict':'结论'}**\n${verdictLabel(event)}` } });
  if (event.author) fields.push({ is_short: true, text: { tag: 'lark_md', content: `**${en?'Author':'作者'}**\n${cardText(event.author, 80)}` } });
  if (event.headSha) fields.push({ is_short: true, text: { tag: 'lark_md', content: `**${en?'Version':'版本'}**\n${cardText(event.headSha, 12)}` } });
  if (event.sourceBranch || event.targetBranch) fields.push({ is_short: false, text: { tag: 'lark_md', content: `**${en?'Branch':'分支'}**\n${cardText(event.sourceBranch || '-', 100)} → ${cardText(event.targetBranch || '-', 100)}` } });
  if (event.projectId) fields.push({ is_short: false, text: { tag: 'lark_md', content: `**${en?'Findings':'问题'}**\nCritical ${Number(findingCounts.critical || 0)} · High ${Number(findingCounts.high || 0)} · Medium ${Number(findingCounts.medium || 0)} · Low ${Number(findingCounts.low || 0)}` } });
  return fields;
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
  const elements = [],en=event._language==='en';
  if (event.title) elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**${cardText(event.title, 220)}**` } });
  const fields = feishuFields(event);
  if (fields.length) elements.push({ tag: 'div', fields });
  const meta = [];
  if (event.occurredAt) meta.push(`${en?'Time':'时间'}：${cardText(event.occurredAt, 40)}`);
  if (event.durationMs) meta.push(`${en?'Duration':'耗时'}：${(Number(event.durationMs) / 1000).toFixed(1)}s`);
  if (event.errorCode) meta.push(`${en?'Error':'错误'}：${cardText(event.errorCode, 80)}`);
  if (!fields.length) meta.push(...summaryLines(event));
  if (meta.length) elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: meta.join(' · ') }] });
  if (event.commits?.length) { const visible=event.commits.slice(0,3),details = visible.map((commit, index) => `${index + 1}. ${cardText(commit.shortSha || commit.sha, 12)}${commit.message ? ` · ${cardText(commit.message, 160)}` : ''}${commit.author ? ` · ${cardText(commit.author, 80)}` : ''}`),remaining=Math.max(0,Number(event.commitCount||event.commits.length)-visible.length); if (remaining) details.push(`… +${remaining} ${event._language==='en'?'more':'条未展开'}`); elements.push({ tag: 'div', text: { tag: 'lark_md', content: `${event._language==='en'?'Commits':'提交摘要'}\n${details.join('\n')}` } }); }
  if (event.jobs?.length) elements.push({ tag: 'div', text: { tag: 'lark_md', content: `${en?'Failed jobs':'失败任务'}\n${event.jobs.map((job, index) => `${index + 1}. ${cardText(job.stage || '-', 80)} · ${cardText(job.name, 120)} · ${cardText(job.failureReason || job.status, 160)}`).join('\n')}` } });
  if (event.topFindings?.length) {const severityIcon={critical:'🔴',high:'🟠',medium:'🟡',low:'🔵',info:'⚪'};elements.push({ tag: 'div', text: { tag: 'lark_md', content: `${event._language==='en'?'Top findings':'重点问题'}\n${event.topFindings.map((finding,index)=>{const impact=finding.impact?`\n   ${event._language==='en'?'Impact':'影响'}：${finding.impact}`:'';return `${index+1}. ${severityIcon[finding.severity]||'⚪'} **${finding.severity.toUpperCase()}** · ${finding.title}\n   ${finding.file}:${finding.line}${impact}`;}).join('\n')}` } });}
  if(event._activity?.length)elements.push({tag:'div',text:{tag:'lark_md',content:`${event._language==='en'?'Change activity':'本次变更动态'}\n${event._activity.slice(-5).map(item=>`• ${cardText(item.type,60)} · ${cardText(item.status||'-',40)}${item.title?` · ${cardText(item.title,100)}`:''}`).join('\n')}`}});
  const actions=[];
  if(event.url){const label=event.flowKind==='pipeline'?(event._language==='en'?'View Pipeline':'查看流水线'):event.flowKind==='commit_push'?(event._language==='en'?'View Compare':'查看代码比较'):String(event.type||'').startsWith('gitlab.')?(event._language==='en'?'View GitLab':'查看 GitLab'):(event._language==='en'?'View Merge Request':'查看合并请求');actions.push({tag:'button',text:{tag:'plain_text',content:label},url:event.url,type:'primary'});}
  const failedJob=event.jobs?.find(job=>job.url);if(failedJob)actions.push({tag:'button',text:{tag:'plain_text',content:event._language==='en'?'View Failed Job':'查看失败任务'},url:failedJob.url,type:'default'});
  if(event._diagnosticsUrl)actions.push({tag:'button',text:{tag:'plain_text',content:event._language==='en'?'Diagnostics':'服务诊断'},url:event._diagnosticsUrl,type:'default'});
  if(actions.length)elements.push({tag:'action',actions:actions.slice(0,3)});
  let card={ header: { template: headerTemplateFor(event), title: { tag: 'plain_text', content: titleFor(event) } }, elements };
  if(Buffer.byteLength(JSON.stringify(card),'utf8')>FEISHU_CARD_MAX_BYTES){const compact=[{tag:'div',text:{tag:'lark_md',content:`**${cardText(event.title||titleFor(event),120)}**\n${event._language==='en'?'Content exceeded the safe card limit; open GitLab for complete details.':'内容超过安全卡片上限，请前往 GitLab 查看完整详情。'}`}}],primary=actions[0];if(primary)compact.push({tag:'action',actions:[primary]});card={header:card.header,elements:compact};}
  return { ...(signature || {}), msg_type: 'interactive', card };
}

function wecomPayload(event) {
  const findingCounts = event.findingCounts || counts([]),en=event._language==='en';
  const horizontal_content_list = String(event.type || '').startsWith('gitlab.')
    ? (event.flowKind === 'pipeline'
      ? [{ keyname: en?'Pipeline':'流水线', value: `#${cardText(event.externalId, 20)}` }, { keyname: en?'Status':'状态', value: cardText(event.status, 26) }, { keyname: 'Ref', value: cardText(event.ref, 26) }, { keyname: en?'Source':'来源', value: cardText(event.source || '-', 26) }]
      : event.flowKind === 'merge_request'
        ? [{ keyname: 'MR', value: `!${Number(event.mrIid) || '-'}` }, { keyname: en?'Status':'状态', value: cardText(event.status, 26) }, { keyname: en?'Branch':'分支', value: cardText(`${event.sourceBranch || '-'}→${event.targetBranch || '-'}`, 26) }, { keyname: en?'Actor':'操作者', value: cardText(event.actor || '-', 26) }]
        : event.flowKind === 'commit_push'
          ? [{ keyname: en?'Branch':'分支', value: cardText(event.ref, 26) }, { keyname: en?'Commits':'提交', value: String(Number(event.commitCount || 0)) }, { keyname: en?'Range':'范围', value: cardText(event.beforeSha && event.afterSha ? `${String(event.beforeSha).slice(0, 8)}→${String(event.afterSha).slice(0, 8)}` : '-', 26) }, { keyname: en?'Pusher':'推送者', value: cardText(event.actor || '-', 26) }]
          : [{ keyname: event.flowKind === 'tag' ? 'Tag' : en?'Branch':'分支', value: cardText(event.ref || event.externalId, 26) }, { keyname: en?'Status':'状态', value: cardText(event.status, 26) }, { keyname: en?'Actor':'操作者', value: cardText(event.actor || '-', 26) }])
    : [
      { keyname: 'MR', value: event.projectId ? `!${Number(event.mrIid) || '-'}` : '-' },
      { keyname: en?'Verdict':'结论', value: cardText(verdictLabel(event), 26) },
      { keyname: en?'Findings':'问题', value: `C${Number(findingCounts.critical || 0)} H${Number(findingCounts.high || 0)} M${Number(findingCounts.medium || 0)} L${Number(findingCounts.low || 0)}` },
      { keyname: en?'Duration':'耗时', value: event.durationMs ? `${(Number(event.durationMs) / 1000).toFixed(1)}s` : '-' }
    ];
  const card = { card_type: 'text_notice', source: { desc: 'Codex Review' }, main_title: { title: cardText(titleFor(event), 26), desc: cardText(event.title || event.sourceBranch || '', 30) }, horizontal_content_list, card_action: { type: 1, url: event.url || 'https://work.weixin.qq.com/' } };
  if(event._activity?.length)card.sub_title_text=cardText(event._activity.slice(-4).map(item=>`${item.type}: ${item.status||'-'}`).join(' · '),112);
  else if (event.commits?.length) card.sub_title_text = cardText(event.commits.slice(0,3).map((commit, index) => `${index + 1}. ${cardText(commit.shortSha || commit.sha, 12)}${commit.message ? ` ${cardText(commit.message, 80)}` : ''}`).concat(Number(event.commitCount||0)>3 ? [`+${Number(event.commitCount)-3} more`] : []).join(' · '), 112);
  else if (event.jobs?.length) card.sub_title_text = cardText(event.jobs.map((job, index) => `${index + 1}. ${job.stage || '-'}/${job.name}: ${job.failureReason || job.status}`).join(' · '), 112);
  else if (event.topFindings?.length) card.sub_title_text = cardText(event.topFindings.map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.title} ${finding.file}:${finding.line}`).join(' · '), 112);
  if (event.url) card.jump_list = [{ type: 1, url: event.url, title: en?(String(event.type || '').startsWith('gitlab.') ? 'View GitLab' : 'View MR'):(String(event.type || '').startsWith('gitlab.')?'查看 GitLab':'查看合并请求') }];
  return { msgtype: 'template_card', template_card: card };
}

function payloadFor(provider, event, route = null, env = process.env) {
  if (provider === 'feishu') { const secret = route ? signingSecretFor(route, env) : ''; return feishuPayload(event, secret ? feishuSignature(secret) : null); }
  if (provider === 'wecom') return wecomPayload(event);
  throw notifyError(`Unsupported webhook notification provider: ${provider}`, 'ENOTIFYPROVIDER');
}

async function postJson(url, payload, timeoutMs, { headers = {}, fetchImpl = fetch, provider = 'notification', method = 'POST' } = {}) {
  let response;
  try { response = await fetchImpl(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) }); }
  catch (cause) { throw notifyError(`${provider} network request failed`, 'ENOTIFYNETWORK', { cause, retryable: true }); }
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {const retryAfter=Number(response.headers?.get?.('retry-after')||0),retryAfterMs=Number.isFinite(retryAfter)&&retryAfter>0?Math.min(86400000,Math.round(retryAfter*1000)):undefined;throw notifyError(`${provider} HTTP ${response.status}`, 'ENOTIFYHTTP', { status: response.status, body, retryAfterMs, retryable: [408, 409, 425, 429].includes(response.status) || response.status >= 500 });}
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
  const retryAfter=Number(body?.retry_after||body?.retry_after_seconds||0),retryAfterMs=Number.isFinite(retryAfter)&&retryAfter>0?Math.min(86400000,Math.round(retryAfter*1000)):undefined;
  return notifyError(`Feishu ${operation} rejected request: ${Number.isFinite(providerCode) ? providerCode : 'unknown'}`, 'EFEISHUAPI', { providerCode, retryAfterMs, retryable: FEISHU_RETRYABLE_CODES.has(providerCode) });
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
  constructor({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) { this.env = env; this.fetchImpl = fetchImpl; this.now = now; this.tokens = new Map(); this.tokenFlights = new Map(); this.nextRequests = new Map(); }
  validate(route) { feishuAppCredentials(route, this.env); }
  tokenKey(credentials) { return `${credentials.appId}:${credentials.appSecret}`; }
  async throttle(key){const now=this.now(),scheduled=Math.max(now,this.nextRequests.get(key)||0);this.nextRequests.set(key,scheduled+FEISHU_MIN_REQUEST_INTERVAL_MS);if(scheduled>now)await sleep(scheduled-now);}
  async tenantAccessToken(route, timeoutMs, forceRefresh = false) {
    const credentials = feishuAppCredentials(route, this.env), key = this.tokenKey(credentials), cached = this.tokens.get(key);
    if (!forceRefresh && cached && cached.expiresAt > this.now()) return { credentials, token: cached.token };
    if(this.tokenFlights.has(key))return this.tokenFlights.get(key);
    const task=(async()=>{await this.throttle(key);const body = await postJson(`${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal`, { app_id: credentials.appId, app_secret: credentials.appSecret }, timeoutMs, { fetchImpl: this.fetchImpl, provider: 'Feishu tenant token' });if (Number(body?.code) !== 0 || !String(body?.tenant_access_token || '').trim()) throw feishuApiError('tenant token', body);const expireSeconds = Number(body.expire ?? body.expires_in ?? 7200),expiresAt = this.now() + Math.max(1, expireSeconds * 1000 - FEISHU_TOKEN_SKEW_MS),token = String(body.tenant_access_token).trim();this.tokens.set(key, { token, expiresAt });return { credentials, token };})();
    this.tokenFlights.set(key,task);try{return await task;}finally{if(this.tokenFlights.get(key)===task)this.tokenFlights.delete(key);}
  }
  async sendWithToken(credentials, token, event, timeoutMs) {
    await this.throttle(this.tokenKey(credentials));
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
  async updateWithToken(credentials, token, messageId, event, timeoutMs) {
    const id = String(messageId || '').trim();
    if (!/^om_[A-Za-z0-9]+$/.test(id)) throw notifyError('Feishu message_id is invalid', 'EFEISHUAPI', { retryable: false });
    await this.throttle(this.tokenKey(credentials));const body = await postJson(`${FEISHU_API_BASE}/im/v1/messages/${encodeURIComponent(id)}`, { msg_type: 'interactive', content: JSON.stringify(feishuPayload(event).card) }, timeoutMs, { method: 'PATCH', headers: { authorization: `Bearer ${token}` }, fetchImpl: this.fetchImpl, provider: 'Feishu message update' });
    if (Number(body?.code) !== 0) throw feishuApiError('message update', body);
    return { remoteId: id, body };
  }
  async update(route, messageId, event, timeoutMs) {
    let session = await this.tenantAccessToken(route, timeoutMs);
    try { return await this.updateWithToken(session.credentials, session.token, messageId, event, timeoutMs); }
    catch (error) {
      if (!isFeishuTokenError(error)) throw error;
      this.tokens.delete(this.tokenKey(session.credentials));
      session = await this.tenantAccessToken(route, timeoutMs, true);
      return this.updateWithToken(session.credentials, session.token, messageId, event, timeoutMs);
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

function notificationDelay(config, item, error = null) {
  if(Number.isFinite(Number(error?.retryAfterMs))&&Number(error.retryAfterMs)>0)return Math.min(config.notificationRetryMaxDelayMs,Number(error.retryAfterMs));
  const base = Math.min(config.notificationRetryMaxDelayMs, config.notificationRetryBaseDelayMs * (2 ** Math.max(0, item.attempt - 1)));
  return Math.round(base * (0.85 + Math.random() * 0.3));
}

class Notifier {
  constructor({ config, store, logger = console, env = process.env, fetchImpl = fetch, now, telemetry = null } = {}) {
    this.config = config; this.store = store; this.logger = logger; this.env = env; this.telemetry = telemetry; this.stopping = false; this.workers = [];
    this.routes = new Map((config.notificationRoutesResolved || []).map(route => [route.name, route]));
    this.providers = createNotificationProviders({ env, fetchImpl, now });
  }
  refreshConfig(config) { this.config = config; this.routes = new Map((config.notificationRoutesResolved || []).map(route => [route.name, route])); }
  reconcileTerminalStatusCards(){for(const card of this.store.terminalReviewStatusCards?.()||[]){const route=this.routes.get(card.route_name);if(!route)continue;const event=eventForFailure({project_id:card.project_id,mr_iid:card.mr_iid,head_sha:card.head_sha,source_branch:card.source_branch},card.job_error||String(card.job_status).toUpperCase()),payload={...event,_language:route.language||'zh-CN',_diagnosticsUrl:cardUrl(route.diagnosticsUrl),_operationType:'status_update',_statusCardOperation:'update',_statusCardJobId:card.job_id};this.store.enqueueNotification({routeName:route.name,provider:route.provider,secretRef:route.secretRef,eventType:event.type,dedupeKey:`job:${card.job_id}:${route.name}:status-card-terminal`,payload});}}
  async execute(item) { const route = this.routes.get(item.route_name); if (!route) throw notifyError(`Notification route disappeared: ${item.route_name}`, 'ENOTIFYROUTE'); const provider = this.providers.get(route.provider); if (!provider) throw notifyError(`Unsupported notification provider: ${route.provider}`, 'ENOTIFYPROVIDER');if(item.payload?._statusCardOperation==='update'){const card=this.store.reviewStatusCard(item.payload._statusCardJobId,item.route_name);if(card?.status==='pending')throw notifyError('Review status card is not ready','ESTATUSCARDPENDING',{retryable:true});if(card&&(card.status==='delivered'||card.status==='updated'))return provider.update(route,card.message_id,item.payload,this.config.notificationRequestTimeoutMs);const result=await provider.send(route,item.payload,this.config.notificationRequestTimeoutMs);return{...result,statusCardFallback:true};}return provider.send(route,item.payload,this.config.notificationRequestTimeoutMs); }
  async process(item) {
    try {
      const aggregateAt=Date.parse(item.payload?._aggregateUntil||'');
      if(Number.isFinite(aggregateAt)&&aggregateAt>Date.now()){this.store.deferNotification(item.id,'EAGGREGATING',aggregateAt-Date.now());return;}
      const result=await this.execute(item);
      if(item.payload?._statusCardOperation==='create')this.store.finishReviewStatusCard(item.payload._statusCardJobId,item.route_name,result.remoteId,'delivered');
      else if(item.payload?._statusCardOperation==='update')this.store.finishReviewStatusCard(item.payload._statusCardJobId,item.route_name,result.remoteId,result.statusCardFallback?'fallback_delivered':'updated');
      this.store.finishNotification(item.id,result.remoteId);this.telemetry?.metrics?.inc('codex_review_notification_delivered_total');
      this.logger.info?.({event:'notification_delivered',outboxId:item.id,route:item.route_name,provider:item.provider,eventType:item.event_type,attempt:item.attempt});
    } catch(error) {
      if(error.code==='ESTATUSCARDPENDING'&&!this.stopping){this.store.deferNotification(item.id,error.code,this.config.notificationPollIntervalMs);return;}
      const retry=item.attempt<this.config.maxNotificationAttempts&&retryableNotification(error)&&!this.stopping;
      if(retry){this.telemetry?.metrics?.inc('codex_review_notification_retries_total');this.store.retryNotification(item.id,error.code||'ENOTIFY',notificationDelay(this.config,item,error));return;}
      if(item.payload?._statusCardOperation==='update'&&!this.stopping){try{const route=this.routes.get(item.route_name),provider=this.providers.get(route?.provider),result=await provider.send(route,item.payload,this.config.notificationRequestTimeoutMs);this.store.finishReviewStatusCard(item.payload._statusCardJobId,item.route_name,result.remoteId,'fallback_delivered');this.store.finishNotification(item.id,result.remoteId);this.telemetry?.metrics?.inc('codex_review_notification_status_card_fallback_total');return;}catch(fallbackError){error=fallbackError;}}
      const metricRoute=String(item.route_name||'unknown').replace(/[^a-zA-Z0-9_]/g,'_').slice(0,64);this.telemetry?.metrics?.inc('codex_review_notification_failures_total');this.telemetry?.metrics?.inc(`codex_review_notification_route_${metricRoute}_failures_total`);if(String(error.message||'').includes('tenant token'))this.telemetry?.metrics?.inc('codex_review_feishu_token_refresh_failures_total');if(item.payload?._statusCardOperation==='create')this.store.failReviewStatusCard(item.payload._statusCardJobId,item.route_name,error.code||'ENOTIFY');this.store.failNotification(item.id,error.code||'ENOTIFY');this.logger.warn?.({event:'notification_failed',outboxId:item.id,route:item.route_name,provider:item.provider,eventType:item.event_type,attempt:item.attempt,code:error.code||'ENOTIFY'});
    }
  }
  async workerLoop() { while (!this.stopping) { this.store.coalescePendingChangeActivities?.(30000);const item = this.store.claimNotification(); if (!item) { this.reconcileTerminalStatusCards(); await sleep(this.config.notificationPollIntervalMs); continue; } await this.process(item); } }
  start() { if (!this.config.notificationEnabled || this.workers.length) return this.workers; this.workers = Array.from({ length: this.config.notificationConcurrency }, () => this.workerLoop()); return this.workers; }
  async stop() { this.stopping = true; await Promise.allSettled(this.workers); }
}

module.exports = { EVENTS, FEISHU_API_BASE, FEISHU_CARD_MAX_BYTES, Notifier, WebhookProvider, FeishuAppProvider, createNotificationProviders, prepareNotificationRoutes, eventForReview, eventForReviewStarted, eventForFailure, systemEvent, planStatusCardActions, planNotificationActions, payloadFor, feishuPayload, wecomPayload, cardText, cardUrl, notificationSecretEnvName, secretEnvName, signingEnvName, appIdEnvName, appSecretEnvName, chatIdEnvName, signingSecretFor, feishuSignature, webhookFor, feishuAppCredentials, retryableNotification, notificationDelay, postJson, postWebhook, feishuApiError, isFeishuTokenError };
