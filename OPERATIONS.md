# Operations Runbook

## Family v4 contract

- Shared Codex/process execution, Safe Contract v2, Policy Schema v3, Review Evidence chunking, deterministic review rules, and Review Receipt v4 are owned by the commit-pinned `codex-safe-core` 4.0.0.
- Service-owned responsibilities are GitLab provider semantics, immutable `start_sha`/`head_sha` evidence acquisition, SQLite schema 4, Queue/Outbox/Publisher, status/discussions, telemetry, and deployment.
- The only repository policy is target-branch `.codex-safe.json` schemaVersion 3; there is no Service-only policy parser or legacy policy fallback.
- Standard and isolated Runner modes execute the same Core runtime.


## Deployment model

Codex Review Service v3.0 is a single-node stateful service backed by SQLite `WAL + synchronous=FULL`. Review execution and GitLab publication are separate durable stages.

- **Standard Deployment**: one `codex-review-service` process with inline Codex.
- **Hardened Deployment**: Controller + isolated Unix-socket Runner.

System-level deployments explicitly use the same `/etc/codex-review/config.json`; direct user-mode execution follows XDG defaults. Use exactly one active Controller per SQLite database; never place SQLite on NFS/SMB/network filesystems.

## Configuration ownership

Direct user-mode execution requires no root-owned paths:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json
${XDG_STATE_HOME:-$HOME/.local/state}/codex-review/
```

`CODEX_REVIEW_CONFIG_FILE` explicitly overrides the config path. Relative XDG home values are ignored.

System-level systemd deployment deliberately pins administrator-owned paths instead of relying on runtime defaults:

```text
/etc/codex-review/config.json        non-secret product configuration
/etc/codex-review-service.env        GitLab/OpenAI secrets only
/etc/codex-review-runner.env         optional Runner OpenAI secret only
/var/lib/codex-review                state (via config + StateDirectory)
```

Supported process environment is intentionally narrow: optional `CODEX_REVIEW_CONFIG_FILE`, required `GITLAB_API_TOKEN`, required `GITLAB_WEBHOOK_SIGNING_TOKEN`, and optional `OPENAI_API_KEY`. Do not reintroduce non-secret environment overrides.

## Standard Deployment preflight

1. Install Node.js 22.13+ and the approved Codex CLI.
2. Require GitLab Self-Managed 19.1+ and configure a Signing Token.
3. Create the `codex-review` non-login user.
4. Install `config.json`, `/etc/codex-review-service.env`, and `codex-review-service.service`.
5. Authenticate Codex as `codex-review` or provision `OPENAI_API_KEY`.
6. Run:

```bash
cd /opt/codex-review-service
sudo -u codex-review /usr/bin/node --env-file=/etc/codex-review-service.env src/doctor.js
```

7. Start the service and require `/health/ready` = 200 before enabling webhooks.

## Multi-repository scope

`gitlab.projects` and `gitlab.groups` form the complete supported scope. `includeSubgroups=true` expands subgroup projects through GitLab's paginated Group Projects API.

A scope refresh is atomic: all configured Group discovery must complete before the active Set changes. On provider/pagination failure, the previous complete Set remains active and readiness becomes unhealthy. If a project leaves the resolved scope, new jobs are rejected and pending Outbox actions are canceled locally before another GitLab mutation.

## Hardened Deployment

Set `runner.mode="isolated"` in `config.json`. Controller and Runner read the same file. Install `codex-review-runner.service`; keep GitLab credentials only on Controller and Codex/OpenAI credentials only on Runner.

Startup order:

```bash
sudo systemctl start codex-review-runner
sudo systemctl start codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
```

## GitLab rollout

Create a GitLab 19.1+ webhook with a Signing Token, enabling Merge Request and Note events. Validate:

1. Doctor resolves the expected Project count.
2. Signed webhook is accepted only for resolved scope.
3. Test MR gets `running`, then terminal status.
4. One durable review run is persisted.
5. Summary/Discussion/status publish through Outbox.
6. Final status targets expected source Project/ref/pipeline.
7. New source push supersedes old snapshot.
8. Group add/remove is reflected after a successful refresh.
9. Removed-scope Outbox entries are canceled without GitLab writes.

## Durability and recovery

- webhook/job persistence: SQLite WAL + FULL;
- running Review Jobs requeue on restart;
- `publication_outbox=publishing` returns to pending;
- publication retry never reruns persisted Codex review;
- stale/out-of-scope publications are canceled;
- delayed `running` cannot overwrite terminal state.

Never delete queue/Outbox rows as an incident workaround without reconciling the intended remote state.

## Upgrade

```bash
cd /opt/codex-review-service
git fetch --tags origin
git checkout <release-tag>
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm pack --dry-run --ignore-scripts
sudo systemctl restart codex-review-runner   # Hardened only
sudo systemctl restart codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
```

Back up SQLite before upgrades.

## v1.x → v2.0 migration

This is a deliberate breaking cleanup. Before deploying v2:

1. copy all non-secret v1 environment settings into `config.json`;
2. replace project allowlist/wildcard with explicit `gitlab.projects/groups`;
3. configure a GitLab Signing Token;
4. remove Legacy Secret Token configuration;
5. set Runner mode/socket only in `config.json`;
6. move lifecycle/budget/concurrency/Codex/OTLP settings into `config.json`;
7. leave only v2-supported secrets in env files;
8. run Doctor and confirm resolved Project count before restoring webhook traffic.

## Backup and restore

Preferred online backup:

```bash
sqlite3 /var/lib/codex-review/review-service.sqlite ".backup '/secure-backup/codex-review-$(date +%F-%H%M%S).sqlite'"
```

For cold backup/restore stop Controller first. Codex authentication state is a separate credential asset.

## Monitoring

Alert on readiness failures, `codex_review_scope_healthy == 0`, unexpected Project-count changes, growing review/publication queues, failed jobs/publications, repeated GitLab circuit opens, sustained worker saturation, Token Budget pressure, and state filesystem capacity.

Logs/traces/metrics must remain metadata-only and avoid repository/branch labels.

## Capacity

Start with `review.concurrency=2` and `publication.concurrency=2`. Different MRs may run concurrently; the same MR stays serialized. Increase Review and Publisher capacity independently from measured usage.

## Common incidents

### Scope discovery failed

Inspect GitLab connectivity, Group permissions and pagination settings. The service keeps the last complete scope and marks readiness unhealthy; do not manually replace it with a partial list.

### GitLab unavailable / rate-limited

Restore connectivity and let bounded retry/circuit-breaker protected queues drain.

### Publication queue grows

Investigate write permissions, pipeline binding and provider 429/5xx. Do not rerun Codex to repair publication-only failures.

### Codex CLI incompatible

Install the tested CLI version or adjust `codex.versionPolicy/allowedVersionPattern` only after contract validation.

### Runner unavailable

Hardened only: inspect Runner service, socket ownership and Codex authentication.

### Queue full / Token Budget / Coverage incomplete

The service fails closed. Investigate capacity/usage/evidence before raising limits.

## GitHub repository governance

CI action upgrades are manually reviewed and pinned to immutable full commit SHAs. Do not enable automated tag-based dependency PRs for Actions. Repository history uses squash merges for release-style `main`; branch cleanup is required after merged PRs.

## Release gate

Before release require `git diff --check`, Node 22.13/24 CI, all config/scope/outbox/Runner/security contracts, package dry-run, bilingual docs consistency, no deprecated v1 configuration paths, no stale version strings, and no temporary migration/deployment artifacts.
