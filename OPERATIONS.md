# Operations Runbook

## Deployment model

Codex Review Service is a single-node stateful service. Use one active process per SQLite database. Terminate TLS at a trusted internal reverse proxy and restrict ingress to GitLab and operators. Keep the service listener on loopback unless direct network exposure is deliberately required.

## Preflight

1. Install Node.js 22.13+ and Codex CLI.
2. Create the dedicated `codex-review` non-login user.
3. Authenticate Codex for that user or provision `OPENAI_API_KEY` through the secret store.
4. Create a GitLab project/group access token with only the project scope and API capabilities the service requires.
5. Fill `/etc/codex-review-service.env` and set mode `0600`.
6. Run `npm run doctor` under the same user/environment as systemd.
7. Confirm `/health/ready` returns HTTP 200 before enabling GitLab webhooks.

## GitLab webhook rollout

Roll out one project first. Enable Merge request and Note events, verify a test MR receives a `running` external commit status, one upserted summary note, inline discussions for validated findings, and a final success/failed status. Then expand `GITLAB_PROJECT_ALLOWLIST`. Explicit IDs enable periodic reconciliation. `*` is webhook-only and should be used only when that tradeoff is intentional.

## Upgrade

```bash
cd /opt/codex-review-service
git fetch --tags origin
git checkout <release-tag>
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
sudo systemctl restart codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
```

Database migrations are additive and applied automatically at startup. Back up the database before upgrades.

## Backup and restore

The database lives at `CODEX_REVIEW_DATA_DIR/review-service.sqlite`. Preferred online backup, when `sqlite3` is installed:

```bash
sqlite3 /var/lib/codex-review/review-service.sqlite ".backup '/secure-backup/codex-review-$(date +%F-%H%M%S).sqlite'"
```

For a cold backup, stop the service and copy the database before restarting. Managed Codex auth under `CODEX_HOME` is a separate credential asset; protect it as a secret.

Restore only while the service is stopped, preserve ownership/mode, then run `npm run doctor` before starting.

## Rollback

Because v1 migrations only add tables/columns/indexes, an earlier v1 build ignores later additive columns. To roll back code, stop the service, check out the prior release, run `npm ci`, run its tests/doctor, and restart. Restore a DB backup only if release notes explicitly declare a non-backward-compatible migration.

## Monitoring

Scrape `/metrics` from a trusted monitoring network. Recommended alerts: readiness != 200 for >5 minutes; queue depth continuously rising; failed jobs rising; active jobs pinned at worker capacity with a growing queue; or state-directory disk usage approaching its limit.

Logs are structured JSON. Index only metadata fields; do not add prompts, diffs, source text, raw Codex output, or credentials.

## Common incidents

### GitLab unavailable

Readiness becomes 503. Already-queued jobs use bounded exponential backoff. Restore GitLab connectivity; do not delete the queue.

### Codex CLI incompatible

Startup capability preflight or `npm run doctor` reports `ECODEXVERSION`. Install a compatible Codex CLI. The service never falls back to weaker safety arguments.

### Codex authentication expired

Run Codex login as `codex-review` or rotate `OPENAI_API_KEY`, then run doctor and restart. `CODEX_HOME` must remain writable for managed-auth token refresh.

### Queue full

The webhook endpoint returns 503 so GitLab can retry. Investigate GitLab/Codex latency or increase workers only after confirming CPU/memory/API capacity.

### Coverage incomplete

Inspect the MR for `too_large`/`collapsed` diffs, binary/unavailable changes, a file larger than `MAX_DIFF_BYTES`, incomplete pagination, or too many chunks. Increase limits carefully or split the MR.

### Manual command rejected

Confirm the commenter is an effective project member at or above `MANUAL_REVIEW_MIN_ACCESS_LEVEL`.

## Secret rotation

Rotate GitLab API and OpenAI credentials independently. For Standard Webhooks token rotation, update GitLab and the service during the provider overlap window; the verifier accepts any signature in the header that matches the configured token.

## Data retention

`DATA_RETENTION_DAYS` prunes terminal jobs and cascaded runs/findings. `WEBHOOK_RETENTION_DAYS` prunes processed webhook delivery IDs. Keep the webhook window long enough to cover realistic retries and incident recovery.

## Capacity

Start with `WORKER_CONCURRENCY=2`. Each worker can own one Codex process. Different MRs may run concurrently; the scheduler never concurrently claims two jobs for the same MR. Increase concurrency gradually while monitoring memory, Codex latency, API throttling, and queue depth.
