'use strict';

function installFairScheduling(store) {
  if (!store?.db || typeof store.withTransaction !== 'function') throw new TypeError('installFairScheduling requires a Store instance.');
  const lastClaim = new Map();
  let sequence = 0;

  store.claimNext = function claimNextFair() {
    return store.withTransaction(() => {
      const now = new Date().toISOString();
      const candidates = store.db.prepare(`
        SELECT j.*
        FROM review_jobs j
        WHERE j.status='queued'
          AND j.available_at<=?
          AND NOT EXISTS(
            SELECT 1 FROM review_jobs r
            WHERE r.project_id=j.project_id AND r.mr_iid=j.mr_iid AND r.status='running'
          )
        ORDER BY j.id
      `).all(now);
      if (!candidates.length) return null;

      const oldestByProject = new Map();
      for (const row of candidates) if (!oldestByProject.has(row.project_id)) oldestByProject.set(row.project_id, row);
      const row = [...oldestByProject.values()].sort((a, b) => {
        const aClaim = lastClaim.get(a.project_id) || 0;
        const bClaim = lastClaim.get(b.project_id) || 0;
        return aClaim - bClaim || a.id - b.id;
      })[0];

      const result = store.db.prepare("UPDATE review_jobs SET status='running',started_at=?,attempt=attempt+1 WHERE id=? AND status='queued'").run(now, row.id);
      if (result.changes !== 1) return null;
      lastClaim.set(row.project_id, ++sequence);
      return store.getJob(row.id);
    });
  };

  return Object.freeze({
    snapshot() { return Object.freeze(Object.fromEntries([...lastClaim.entries()].map(([projectId, order]) => [String(projectId), order]))); }
  });
}

module.exports = { installFairScheduling };
