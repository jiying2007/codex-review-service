# Operations Runbook

## Deployment model

Codex Review Service v1.1 is a single-node stateful controller backed by SQLite `WAL + synchronous=FULL`. Review execution and GitLab publication are separate durable stages. The recommended production layout also runs Codex in a separate Unix-socket Runner process/user.

Use exactly one active controller per SQLite database. Do not place the database on NFS/SMB/network filesystems.

## Recommended process split

```text
codex-review controller
  GitLab credentials + SQLite
        │ Unix socket
        ▼
codex-review-runner
  Codex/OpenAI credential only
```

Controller configuration should set:

```text
CODEX_RUNNER_SOCKET=/run/codex-review-runner/runner.sock
```

Runner configuration belongs in `/etc/codex-review-runner.env`; GitLab credentials must not be copied there.

## Preflight

1. Install Node.js 22.13+ and the production-approved Codex CLI version.
2. Create `codex-review` and, for split mode, `codex-review-runner` non-login users.
3. Provision GitLab API/webhook credentials only to the controller.
4. Authenticate Codex or provision `OPENAI_API_KEY` only to the Runner in split mode.
5. Install `/etc/codex-review-service.env` and `/etc/codex-review-runner.env` with mode `0600`.
6. Install both systemd units when using split mode.
7. Run `npm run doctor` using the same controller environment.
8. Confirm `/health/ready` returns 200 before enabling production webhooks.

## Startup order

Recommended:

```bash
sudo systemctl start codex-review-runner
sudo systemctl start codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
```

Readiness requires the DB, Review Workers, Publisher Workers, GitLab and Codex/Runner capability path to be healthy.

## GitLab rollout

Start with one explicit Project ID in `GITLAB_PROJECT_ALLOWLIST`. Enable Merge request and Note events. Verify a test MR produces:

1. accepted/authenticated webhook delivery;
2. one queued review job;
3. `running` external status;
4. one persisted review run;
5. summary + inline findings through the publication outbox;
6. final success/failed status bound to the expected source project/ref/pipeline;
7. a later source push supersedes the old review and prevents stale publication.

Expand the allowlist only after this path is healthy. Wildcard mode disables exhaustive reconciliation.

## Durability and recovery

Webhook/job persistence uses SQLite `WAL + synchronous=FULL`. Review results, findings and their publication actions are committed in one transaction. GitLab publication happens later from `publication_outbox`.

Crash recovery rules:

- `review_jobs.status=running` → requeued on startup;
- `publication_outbox.status=publishing` → returned to pending on startup;
- publication retry never reruns Codex;
- stale summary/finding publications are canceled when the MR snapshot no longer matches;
- terminal status publications use stable dedupe keys.

Never manually delete pending outbox rows as an incident workaround unless the corresponding GitLab side effect and desired terminal state have been reconciled first.

## Upgrade

```bash
cd /opt/codex-review-service
git fetch --tags origin
git checkout <release-tag>
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm pack --dry-run --ignore-scripts
sudo systemctl restart codex-review-runner   # split mode
sudo systemctl restart codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
```

Migrations are additive in v1.x and run automatically. Back up SQLite before upgrades.

## Backup and restore

Preferred online backup when `sqlite3` is installed:

```bash
sqlite3 /var/lib/codex-review/review-service.sqlite ".backup '/secure-backup/codex-review-$(date +%F-%H%M%S).sqlite'"
```

For a cold backup, stop the controller before copying the DB. Runner `CODEX_HOME` is a separate credential asset; protect it independently and do not treat it as application state.

Restore only with the controller stopped, preserve ownership/mode, then run doctor and readiness checks before reenabling webhooks.

## Rollback

For v1.x additive migrations, an earlier compatible build should ignore later additive columns/tables. Rollback procedure:

1. stop the controller and Runner;
2. restore a known-compatible code tag;
3. `npm ci --ignore-scripts --no-audit --no-fund`;
4. run its tests and doctor;
5. start Runner then controller;
6. verify readiness and one test MR.

Restore a DB backup only when release notes declare schema incompatibility or migration corruption.

## Monitoring

Scrape `/metrics` from a trusted monitoring network. Recommended alerts:

- readiness != 200 for >5 minutes;
- review queue depth continuously rising;
- publication queue depth continuously rising;
- failed jobs increasing;
- failed publication actions increasing;
- active Review Workers pinned at capacity while queue grows;
- GitLab circuit breaker repeatedly opening;
- project token usage approaching `PROJECT_DAILY_TOKEN_BUDGET`;
- state-directory disk usage approaching capacity.

Optional OTLP/HTTP-compatible trace export can be enabled with `OTEL_EXPORTER_OTLP_ENDPOINT`. Trace/log metadata may include job/run/project/MR identifiers but must not include source code, prompt text, raw model output or credentials.

## Capacity

Start with `WORKER_CONCURRENCY=2` and `PUBLISHER_CONCURRENCY=2`. Review Workers consume Codex capacity; Publisher Workers mainly consume GitLab API capacity. Increase them independently.

Use `REVIEW_DEBOUNCE_MS` to coalesce push bursts. Prefer `REVIEW_DRAFT_MERGE_REQUESTS=false` unless draft reviews are explicitly valuable.

Context and cost ceilings should remain bounded:

```text
MAX_DIFF_BYTES
MAX_REVIEW_CHUNKS
MAX_CONTEXT_BYTES
MAX_CONTEXT_FILES
CONTEXT_LINES
MR_MAX_TOKEN_BUDGET
PROJECT_DAILY_TOKEN_BUDGET
```

## Common incidents

### GitLab unavailable / rate-limited

Readiness becomes unhealthy or GitLab requests fail. Review/publisher work uses bounded retry/backoff; the GitLab circuit breaker prevents worker storms. Do not delete queues. Restore connectivity and allow pending work to drain.

### Publication queue grows while review queue is healthy

Investigate GitLab write permissions, status pipeline binding, 429/5xx responses and circuit-breaker state. Codex should not be rerun to repair publication failures.

### Codex CLI incompatible

Doctor/startup reports `ECODEXVERSION`. Install the tested version or update `CODEX_ALLOWED_VERSION_PATTERN` only after CI/contract validation. Never weaken required Safe Contract flags as an emergency workaround.

### Runner unavailable

With `CODEX_RUNNER_SOCKET` configured, readiness fails and review jobs should not be treated as healthy. Check `codex-review-runner.service`, socket ownership/group mode and Runner Codex authentication.

### Codex authentication expired

Authenticate/rotate credentials as `codex-review-runner` in split mode. Restart Runner and rerun doctor. Controller GitLab credentials do not need to change.

### Queue full

Webhook returns 503 so GitLab can retry. Investigate GitLab/Codex latency, capacity, debounce and token budgets before raising `MAX_QUEUE_DEPTH`.

### Token budget exhausted

The review becomes incomplete/failed rather than silently skipping work. Adjust budgets only after reviewing actual usage metrics and project risk.

### Coverage incomplete

Inspect summary coverage gaps. Genuine blockers include provider pagination/hard-limit truncation, `too_large`, `collapsed`, unknown unavailable diffs, local file/chunk/token ceilings or invalid model findings. Known binary/metadata-only/generated cases are separately classified and are policy-controlled.

### Manual command rejected

Confirm the author is an effective project member at or above `MANUAL_REVIEW_MIN_ACCESS_LEVEL`.

## Secret rotation

Rotate GitLab and OpenAI/Codex credentials independently. In split mode they are owned by different service accounts/environment files. For Standard Webhooks signing-token rotation, coordinate GitLab and controller configuration during the provider overlap window.

## Data retention

`DATA_RETENTION_DAYS` prunes terminal review jobs and cascaded run/finding/outbox data. `WEBHOOK_RETENTION_DAYS` prunes processed webhook delivery IDs. Keep retention long enough for realistic incident investigation and GitLab retry windows.

## Release gate

Before marking a release ready:

- `git diff --check` passes;
- Node 22.13.0 and 24 CI are green;
- Runner contract tests are green;
- `npm pack --dry-run --ignore-scripts` succeeds;
- README/README.zh-CN/OPERATIONS/SECURITY/ARCHITECTURE agree on the trust and durability model;
- the final PR diff has no transitional compatibility code or temporary deployment files.