'use strict';

// One SQL row per runnable project rather than materializing the entire queue
// in JavaScript. No cross-GitLab IDs or schema migration are introduced.
function installFairScheduling(store) {
  if (!store?.db || typeof store.withTransaction !== 'function') throw new TypeError('installFairScheduling requires a Store instance.');
  const lastClaim = new Map();
  let sequence = 0;
  const oldestByProject = store.db.prepare(`
    WITH eligible AS (
      SELECT j.id, j.project_id,
        ROW_NUMBER() OVER (PARTITION BY j.project_id ORDER BY j.id) AS ordinal
      FROM review_jobs j
      WHERE j.status='queued' AND j.available_at<=?
        AND NOT EXISTS (
          SELECT 1 FROM review_jobs r
          WHERE r.project_id=j.project_id AND r.mr_iid=j.mr_iid AND r.status='running'
        )
    )
    SELECT j.*,
      (SELECT MAX(previous.started_at) FROM review_jobs previous
       WHERE previous.project_id=j.project_id AND previous.started_at IS NOT NULL) AS last_project_started_at
    FROM eligible e
    JOIN review_jobs j ON j.id=e.id
    WHERE e.ordinal=1
    ORDER BY j.id
  `);
  const startJob = store.db.prepare(
    "UPDATE review_jobs SET status='running',started_at=?,attempt=attempt+1 WHERE id=? AND status='queued'"
  );
  store.claimNext = function claimNextFair() {
    return store.withTransaction(() => {
      const now = new Date().toISOString();
      const candidates = oldestByProject.all(now);
      if (!candidates.length) return null;
      const row = candidates.sort((a,b) => {
        // Active-process sequence prevents a millisecond-level timestamp tie;
        // persisted started_at provides an approximate restart fairness floor.
        const aRecent=lastClaim.get(a.project_id);
        const bRecent=lastClaim.get(b.project_id);
        if(aRecent!==undefined && bRecent!==undefined) return aRecent-bRecent || a.id-b.id;
        if(aRecent!==undefined) return 1;
        if(bRecent!==undefined) return -1;
        const aTime=a.last_project_started_at||'';
        const bTime=b.last_project_started_at||'';
        return aTime.localeCompare(bTime) || a.id-b.id;
      })[0];
      const result=startJob.run(now,row.id);
      if(result.changes!==1) return null;
      lastClaim.set(row.project_id,++sequence);
      return store.getJob(row.id);
    });
  };
  return Object.freeze({
    snapshot() { return Object.freeze(Object.fromEntries([...lastClaim.entries()].map(([projectId,order])=>[String(projectId),order]))); }
  });
}
module.exports={installFairScheduling};
