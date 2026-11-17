'use strict';

const QUEUE_TABLES = new Set(['review_jobs', 'publication_outbox', 'notification_outbox']);
function unavailable() {
  return Object.assign(new Error('Queue age metrics unavailable'), {
    code: 'EMETRICSUNAVAILABLE', status: 503
  });
}
function oldestAgeSeconds(value, now = Date.now()) {
  if (!Number.isFinite(now)) throw unavailable();
  if (value === null) return 0;
  if (typeof value !== 'string' || !value.trim()) throw unavailable();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw unavailable();
  return Math.max(0, (now - timestamp) / 1000);
}
function ageSeconds(store, table, statuses) {
  if (!QUEUE_TABLES.has(table) || !Array.isArray(statuses) || !statuses.length ||
      statuses.some(status => typeof status !== 'string' || !/^[a-z_]+$/.test(status))) {
    throw unavailable();
  }
  try {
    const placeholders = statuses.map(() => '?').join(',');
    const row = store.db.prepare(`SELECT MIN(created_at) value FROM ${table} WHERE status IN (${placeholders})`).get(...statuses);
    // A real SQL aggregate returns {value:null} for an empty queue. Missing
    // rows, corrupt timestamps and database errors are NOT a healthy zero.
    return oldestAgeSeconds(row?.value);
  } catch {
    throw unavailable();
  }
}
module.exports = { ageSeconds, oldestAgeSeconds };
