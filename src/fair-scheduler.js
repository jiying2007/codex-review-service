'use strict';

// One SQL row per runnable project, preserving the per-MR running fence.
// Persisted history is needed only until a project is first served locally.
function installFairScheduling(store) {
  if (!store?.db || typeof store.withTransaction !== 'function') throw new TypeError('installFairScheduling requires a Store instance.');
  const lastClaim = new Map(), restartTimes = new Map();
  let sequence = 0;
  const oldestByProject = store.db.prepare(`
    WITH eligible AS (
      SELECT j.project_id, MIN(j.id) AS id
      FROM review_jobs j
      WHERE j.status='queued' AND j.available_at<=?
        AND NOT EXISTS (
          SELECT 1 FROM review_jobs r
          WHERE r.project_id=j.project_id AND r.mr_iid=j.mr_iid AND r.status='running'
        )
      GROUP BY j.project_id
    )
    SELECT j.* FROM eligible e JOIN review_jobs j ON j.id=e.id ORDER BY j.id
  `);
  const previousStart = store.db.prepare(
    'SELECT MAX(started_at) AS value FROM review_jobs WHERE project_id=? AND started_at IS NOT NULL'
  );
  const startJob = store.db.prepare(
    "UPDATE review_jobs SET status='running',started_at=?,attempt=attempt+1 WHERE id=? AND status='queued'"
  );
  store.claimNext = function claimNextFair() {
    return store.withTransaction(() => {
      const now = new Date().toISOString();
      const candidates = oldestByProject.all(now);
      if (!candidates.length) return null;
      for (const row of candidates) {
        if (!lastClaim.has(row.project_id) && !restartTimes.has(row.project_id))
          restartTimes.set(row.project_id, previousStart.get(row.project_id).value || '');
      }
      const row = candidates.sort((a, b) => {
        const aRecent = lastClaim.get(a.project_id), bRecent = lastClaim.get(b.project_id);
        if (aRecent !== undefined && bRecent !== undefined) return aRecent - bRecent || a.id - b.id;
        if (aRecent !== undefined) return 1;
        if (bRecent !== undefined) return -1;
        return restartTimes.get(a.project_id).localeCompare(restartTimes.get(b.project_id)) || a.id - b.id;
      })[0];
      const result = startJob.run(now, row.id);
      if (result.changes !== 1) return null;
      const job = store.getJob(row.id);
      const remember = () => { lastClaim.set(row.project_id, ++sequence); restartTimes.delete(row.project_id); };
      // Real Store afterCommit runs only after the outermost durable commit.
      // Do not advance local fairness when an enclosing transaction rolls back.
      if (typeof store.afterCommit === 'function') store.afterCommit(remember);
      else remember();
      return job;
    });
  };
  return Object.freeze({
    snapshot() { return Object.freeze(Object.fromEntries([...lastClaim.entries()].map(([projectId, order]) => [String(projectId), order]))); }
  });
}
module.exports = { installFairScheduling };
