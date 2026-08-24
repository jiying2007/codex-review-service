# Operations Runbook

## Family v4 contract

- Shared Codex/process execution, Safe Contract v2, Policy Schema v3, Review Evidence chunking, deterministic review rules, and Review Receipt v4 are owned by the exact commit-pinned `codex-safe-core` 4 runtime.
- Service-owned responsibilities are GitLab provider semantics, immutable `start_sha`/`head_sha` evidence acquisition, SQLite schema 4, Queue/Outbox/Publisher, status/discussions, telemetry, and deployment.
- The only repository policy is target-branch `.codex-safe.json` schemaVersion 3; there is no Service-only policy parser or legacy policy fallback.
- Standard and isolated Runner modes execute the same Core runtime.

## Deployment model

Codex Review Service 4.x is a single-node stateful service backed by SQLite `WAL + synchronous=FULL`. Review execution and GitLab publication are separate durable stages.

- **Direct user mode**: runs as the invoking user with XDG config/state defaults and no root-owned path requirement.
- **Standard system deployment**: one `codex-review-service` process with inline Codex.
- **Hardened system deployment**: Controller + isolated Unix-socket Runner.

Use exactly one active Controller per SQLite database. Never place SQLite on NFS/SMB/network filesystems.

## Configuration ownership

There is one JSON configuration model, not one hard-coded filesystem location.

Direct user mode uses the root `config.example.json` and defaults to:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json
${XDG_STATE_HOME:-$HOME/.local/state}/codex-review/
```

The root example intentionally omits `server.dataDir`. `CODEX_REVIEW_CONFIG_FILE` explicitly selects another config file. Relative XDG home values are ignored and standard `$HOME` fallbacks are used.

System-level systemd deployment uses `deploy/systemd/config.example.json` and explicitly owns:

```text
/etc/codex-review/config.json        non-secret product configuration
/etc/codex-review-service.env        GitLab/OpenAI secrets only
/etc/codex-review-runner.env         optional Runner OpenAI secret only
/var/lib/codex-review                state (systemd config + StateDirectory)
```

Both systemd units explicitly set `CODEX_REVIEW_CONFIG_FILE=/etc/codex-review/config.json`; runtime code does not detect root, sudo, or systemd.

Supported process environment remains intentionally narrow: optional `CODEX_REVIEW_CONFIG_FILE`, required `GITLAB_API_TOKEN`, required `GITLAB_WEBHOOK_SIGNING_TOKEN`, and optional `OPENAI_API_KEY`. Do not reintroduce non-secret environment overrides.

## Direct user-mode preflight

1. Install Node.js 22.13+ and the approved Codex CLI.
2. Create `${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json` from root `config.example.json`.
3. Configure GitLab Project/Group scope and signing token.
4. Authenticate Codex as the invoking user or export `OPENAI_API_KEY`.
5. Run `npm run doctor`, then `npm start`.

The default Runner mode is inline. A direct user-mode isolated Runner must explicitly configure an absolute socket path writable by both processes; `/run/codex-review-runner/runner.sock` belongs to the systemd deployment template.

## Standard system deployment preflight

1. Install Node.js 22.13+ and the approved Codex CLI.
2. Require GitLab Self-Managed 19.1+ and configure a Signing Token.
3. Create the `codex-review` non-login user.
4. Install `deploy/systemd/config.example.json` as `/etc/codex-review/config.json`, then install `/etc/codex-review-service.env` and `codex-review-service.service`.
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

## Hardened deployment

Set `runner.mode="isolated"` in the systemd config. Controller and Runner consume the same file. Both units explicitly point to `/etc/codex-review/config.json`; GitLab credentials stay only on Controller and Codex/OpenAI credentials only on Runner.

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

Verify downloaded release artifacts before deployment as described in `VERIFY_RELEASE.md`. Back up SQLite before upgrades.

## Backup and restore

For system-level deployment:

```bash
sqlite3 /var/lib/codex-review/review-service.sqlite ".backup '/secure-backup/codex-review-$(date +%F-%H%M%S).sqlite'"
```

For direct user mode, use the configured `server.dataDir` or the XDG state default instead. For cold backup/restore stop Controller first. Codex authentication state is a separate credential asset.

## Monitoring

Alert on readiness failures, `codex_review_scope_healthy == 0`, unexpected Project-count changes, growing review/publication queues, failed jobs/publications, repeated GitLab circuit opens, sustained worker saturation, Token Budget pressure, and state filesystem capacity.

Logs/traces/metrics must remain metadata-only and avoid repository/branch labels.

## Common incidents

### Scope discovery failed

Inspect GitLab connectivity, Group permissions and pagination settings. The service keeps the last complete scope and marks readiness unhealthy.

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

## Repository governance

CI actions remain immutable full-SHA pinned. Repository history uses audited squash merges for release-style changes; merged feature branches are disposable and must be cleaned. Documentation-only/governance maintenance does not require product version churn when package/runtime semantics are unchanged.

## Release gate

Before release require `git diff --check`, Node 22.13/24 CI, config/scope/outbox/Runner/security contracts, package dry-run, bilingual docs consistency, no current-doc legacy version labels, no temporary migration/deployment artifacts, no runtime compatibility residue, and consumer-verifiable checksum/provenance instructions.
