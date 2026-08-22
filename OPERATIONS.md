# Operations Runbook

## Deployment model

Codex Review Service v1.2 remains a single-node stateful service backed by SQLite `WAL + synchronous=FULL`. Review execution and GitLab publication are separate durable stages.

The default **Standard Deployment** runs one `codex-review-service` process with inline Codex. The optional **Hardened Deployment** adds the isolated Unix-socket Runner. Use exactly one active Controller per SQLite database and never place SQLite on NFS/SMB/network filesystems.

## Standard Deployment

Recommended files:

```text
/etc/codex-review/config.json        # non-secret product settings
/etc/codex-review-service.env        # GitLab/OpenAI secrets + rare overrides
/etc/systemd/system/codex-review-service.service
```

Minimal config:

```json
{
  "gitlab": {
    "baseUrl": "https://gitlab.example.internal",
    "projects": [101, 102],
    "groups": [{ "id": 20, "includeSubgroups": true }]
  },
  "review": { "concurrency": 2 },
  "runner": { "mode": "inline" }
}
```

Minimal protected environment:

```text
GITLAB_API_TOKEN=...
GITLAB_WEBHOOK_SIGNING_TOKEN=whsec_...
```

Preflight:

1. install Node.js 22.13+ and the approved Codex CLI;
2. create the `codex-review` non-login user;
3. install `config.json`, environment file and the Controller systemd unit;
4. run `codex login` as `codex-review` or provision `OPENAI_API_KEY`;
5. run `npm run doctor` under the service environment;
6. verify `/health/ready` before enabling production webhooks.

## Multi-repository project scope

`gitlab.projects` and `gitlab.groups` form one runtime allowlist. A group entry can set `includeSubgroups=true`; the service asks GitLab's paginated Group Projects API to return projects in that scope, excludes archived projects, filters to Merge-Request-enabled projects, merges IDs with explicit projects and deduplicates them.

Project discovery runs at startup and again on the reconciliation cadence when groups are configured. A refresh is atomic from the service's point of view: if any group lookup fails or pagination is incomplete, the last complete project set remains active and readiness becomes unhealthy until a complete refresh succeeds. This avoids silently dropping repositories during a GitLab incident.

Legacy `GITLAB_PROJECT_ALLOWLIST` is still accepted. When present, it overrides structured `projects/groups`. Wildcard `*` is intentionally webhook-only and disables exhaustive reconciliation.

## Hardened Deployment

Set `runner.mode="isolated"` and optionally `runner.socket`. Install `codex-review-runner.service` and `/etc/codex-review-runner.env` under the separate `codex-review-runner` user. GitLab credentials stay on the Controller; Codex/OpenAI credentials stay on the Runner.

Startup order:

```bash
sudo systemctl start codex-review-runner
sudo systemctl start codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
```

## GitLab rollout

Start with one explicit Project ID or one small Group. Enable Merge request and Note events. Verify:

1. Doctor reports the expected resolved project count;
2. webhook delivery is accepted only for the resolved scope;
3. a test MR gets a `running` status;
4. one durable review run is persisted;
5. Summary/Discussion/final status are published through the Outbox;
6. final status targets the expected source project/ref/pipeline;
7. a later push supersedes the old snapshot;
8. adding/removing a project in a configured Group is reflected after a successful scope refresh.

## Durability and recovery

Webhook/job persistence uses SQLite `WAL + synchronous=FULL`. Review results, findings and publication actions are committed in one transaction; Publisher Workers process GitLab writes later.

Crash recovery rules:

- running Review Jobs are requeued;
- publishing Outbox actions return to pending;
- publication retry never reruns an already-persisted Codex review;
- stale Summary/Finding publications are canceled;
- delayed `running` status cannot overwrite terminal status.

## Upgrade

```bash
cd /opt/codex-review-service
git fetch --tags origin
git checkout <release-tag>
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm pack --dry-run --ignore-scripts
sudo systemctl restart codex-review-runner   # only in Hardened mode
sudo systemctl restart codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
```

Migrations are additive in v1.x. Back up SQLite before upgrades.

## Backup and restore

Preferred online backup:

```bash
sqlite3 /var/lib/codex-review/review-service.sqlite ".backup '/secure-backup/codex-review-$(date +%F-%H%M%S).sqlite'"
```

For cold backup/restore, stop the Controller. Codex auth state is a separate credential asset and must be protected independently.

## Monitoring

Alert on:

- readiness != 200 for >5 minutes;
- `codex_review_scope_healthy == 0`;
- resolved project count unexpectedly changes;
- review/publication queue depth continuously rises;
- failed review or publication actions increase;
- GitLab circuit breaker repeatedly opens;
- worker capacity remains saturated;
- project Token Budget approaches its limit;
- state filesystem approaches capacity.

Metrics use low-cardinality labels. Logs/traces must not contain source code, prompts, raw model output or credentials.

## Capacity

Start with `review.concurrency=2` and `PUBLISHER_CONCURRENCY=2`. Review concurrency controls different-MR parallelism; the scheduler always serializes the same MR. Increase Review and Publisher concurrency independently after observing CPU/memory/Codex/GitLab capacity.

## Common incidents

### Project-scope discovery failed

`/health/ready` reports an unhealthy project scope. Inspect GitLab connectivity, group permissions and pagination/limit settings. The service intentionally keeps the last complete project set; do not replace it manually with a partial list during the incident.

### Unexpected project not reviewed

Run `npm run doctor` and compare `explicitProjects`, `groups`, `discoveredProjects`, and `totalProjects`. Check whether a legacy `GITLAB_PROJECT_ALLOWLIST` environment value is overriding `config.json`.

### GitLab unavailable / rate-limited

The circuit breaker and bounded retry prevent worker storms. Restore GitLab connectivity and let queued work drain.

### Publication queue grows while review queue is healthy

Investigate GitLab write permissions, status pipeline binding and 429/5xx responses. Do not rerun Codex to repair a publication-only failure.

### Codex CLI incompatible

Doctor/startup reports `ECODEXVERSION`. Install the tested CLI version or change the allowed version policy only after CI/contract validation.

### Runner unavailable

This applies only to Hardened mode. Check the Runner service, Unix socket ownership and Runner-side Codex authentication.

### Queue full / Token Budget exhausted / Coverage incomplete

The service fails closed rather than silently dropping work. Investigate capacity and actual usage before raising limits.

## Release gate

Before release:

- `git diff --check` passes;
- Node 22.13.0 and 24 CI are green;
- strict config/project-scope tests are green;
- Runner contract tests remain green;
- `npm pack --dry-run --ignore-scripts` succeeds;
- README/README.zh-CN/OPERATIONS/SECURITY/ARCHITECTURE agree on Standard/Hardened deployment and project-scope semantics;
- final PR diff has no temporary migration/deployment artifacts.
