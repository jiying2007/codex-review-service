'use strict';
// Local, low-cardinality, read-only per-repository operational metrics.
// Unknown model-call usage is never silently substituted with zero tokens.
const { oldestAgeSeconds } = require('./metrics-age');
const MAX_PROJECTS = 256;
function repositoryCounts(db, selected, maxProjects) {
  if (selected && !selected.length) return [];
  const clause = selected ? ' WHERE project_id IN (' + selected.map(() => '?').join(',') + ')' : '';
  // Count historical rows using the existing project/MR covering index; do
  // not read historical status/timestamp payloads just to count retained jobs.
  const totals = db.prepare('SELECT project_id,COUNT(*) total FROM review_jobs' + clause +
    ' GROUP BY project_id ORDER BY project_id' + (selected ? '' : ' LIMIT ?')).all(...(selected || [maxProjects + 1]));
  const projects = totals.slice(0, maxProjects);
  if (!projects.length) return totals;
  const placeholders = projects.map(() => '?').join(',');
  const active = db.prepare(
    "SELECT project_id,SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued," +
    "SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) running," +
    "MIN(CASE WHEN status='queued' THEN created_at END) oldest " +
    "FROM review_jobs WHERE status IN ('queued','running') AND project_id IN (" + placeholders + ') GROUP BY project_id'
  ).all(...projects.map(row => row.project_id));
  const byProject = new Map(active.map(row => [row.project_id, row]));
  return totals.map(row => ({ ...row, queued: 0, running: 0, oldest: null, ...byProject.get(row.project_id) }));
}
function renderRepositoryMetrics(store, { maxProjects = MAX_PROJECTS, now = Date.now(), projectIds = null } = {}) {
  if (!store?.db?.prepare) throw new TypeError('Repository metrics require a real SQLite Store');
  if (!Number.isSafeInteger(maxProjects) || maxProjects < 1 || maxProjects > MAX_PROJECTS)
    throw new RangeError('Invalid repository metrics bound');
  const since = new Date(now);
  if (!Number.isFinite(since.getTime())) throw new TypeError('Invalid metrics timestamp');
  since.setUTCHours(0, 0, 0, 0);
  if (projectIds !== null && !Array.isArray(projectIds) && !(projectIds instanceof Set))
    throw new TypeError('Project metric scope must be a Set or array');
  const scope = projectIds === null ? null : [...new Set(projectIds)];
  if (scope && scope.some(id => !Number.isSafeInteger(id) || id < 1))
    throw new TypeError('Unsafe repository metric scope identity');
  scope?.sort((a, b) => a - b);
  const selected = scope ? scope.slice(0, maxProjects) : null;
  const rows = repositoryCounts(store.db, selected, maxProjects);
  const complete = selected ? scope.length <= maxProjects : rows.length <= maxProjects;
  const projects = rows.slice(0, maxProjects);
  if (projects.some(row => !Number.isSafeInteger(row.project_id) || row.project_id < 1))
    throw new Error('Invalid persisted repository identity');
  const placeholders = projects.map(() => '?').join(',');
  const tokens = projects.length ? store.db.prepare(
    'SELECT j.project_id,' +
    'SUM(CASE WHEN c.usage_known=1 THEN COALESCE(c.input_tokens,0)+COALESCE(c.output_tokens,0) ELSE 0 END) known,' +
    'SUM(CASE WHEN c.usage_known=0 THEN 1 ELSE 0 END) unknown ' +
    'FROM model_calls c JOIN review_jobs j ON j.id=c.job_id ' +
    'WHERE c.started_at>=? AND j.project_id IN (' + placeholders + ') GROUP BY j.project_id'
  ).all(since.toISOString(), ...projects.map(p => p.project_id)) : [];
  const usage = new Map(tokens.map(row => [row.project_id, row]));
  const lines = [
    '# TYPE codex_review_repository_metrics_complete gauge',
    'codex_review_repository_metrics_complete ' + (complete ? '1' : '0'),
    '# TYPE codex_review_repository_jobs gauge',
    '# TYPE codex_review_repository_oldest_queue_age_seconds gauge',
    '# TYPE codex_review_repository_known_model_tokens_today gauge',
    '# TYPE codex_review_repository_unknown_model_calls_today gauge'
  ];
  for (const p of projects) {
    const id = String(p.project_id), label = '{project_id="' + id + '"}';
    for (const [state, number] of [['total', p.total], ['queued', p.queued], ['running', p.running]]) {
      const value = Number(number);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid persisted per-project job count');
      lines.push('codex_review_repository_jobs{project_id="' + id + '",status="' + state + '"} ' + value);
    }
    const age = Math.floor(oldestAgeSeconds(p.oldest, now));
    lines.push('codex_review_repository_oldest_queue_age_seconds' + label + ' ' + age);
    const stats = usage.get(p.project_id);
    const known = Number(stats?.known ?? 0), unknown = Number(stats?.unknown ?? 0);
    if (!Number.isSafeInteger(known) || known < 0 || !Number.isSafeInteger(unknown) || unknown < 0)
      throw new Error('Invalid persisted per-project model usage');
    lines.push('codex_review_repository_known_model_tokens_today' + label + ' ' + known);
    lines.push('codex_review_repository_unknown_model_calls_today' + label + ' ' + unknown);
  }
  return lines.join('\n') + '\n';
}
module.exports = { renderRepositoryMetrics, repositoryCounts, MAX_PROJECTS };
