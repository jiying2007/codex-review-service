# Operations Runbook

## Product baseline

Codex Review Service **5.1.0** is the compatibility/production-operations baseline. Machine-readable compatibility is owned by `product-contract.json`:

- Database Schema 5
- Config Schema 2
- Policy Schema 3
- Review Receipt 4
- Safe Contract 2 / Safe Core Family v4 exact commit pin
- Native/systemd Node.js: 22 LTS >=22.22.2 or 24 LTS >=24.19.0; Node 23 unsupported
- Canonical Docker Node.js: 24.19.0
- GitLab Self-Managed compatibility floor: >=14.6.1
- GitLab recommendation: vendor-supported release
- GitLab profiles: Classic 14.6.1..<15.7; Modern >=15.7

The service owns GitLab provider/capability semantics, immutable `start_sha`/`head_sha` evidence, SQLite Schema 5, durable Review Queue, GitLab Publication Outbox, Notification Outbox, telemetry and deployment. Shared Codex/process execution remains in exact-pinned `codex-safe-core`.

## Deployment model

This is intentionally a **single-node stateful service** backed by local SQLite `WAL + synchronous=FULL`. Use exactly one active Controller per database and never place the database on NFS/SMB/network filesystems.

- Direct user mode: XDG config/state defaults; use supported Node 22/24 LTS.
- Standard system deployment: one `codex-review-service` process with inline Codex.
- Hardened deployment: Controller + isolated Unix-socket Runner.
- Docker/Compose: canonical release OCI image with Node 24.19.0 and persistent local state volume.

One instance is one administrative/security trust domain. Separate instances are preferred over hidden multi-tenant credential sharing.

## Configuration ownership

Direct user mode:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json
${XDG_STATE_HOME:-$HOME/.local/state}/codex-review/
```

System deployment:

```text
/etc/codex-review/config.json        Config Schema 2, non-secret
/etc/codex-review/secrets/*          protected secret files
/etc/codex-review-service.env        paths to secret files + process selection only
/var/lib/codex-review                SQLite/state
```

Both systemd units explicitly set `CODEX_REVIEW_CONFIG_FILE=/etc/codex-review/config.json`. Runtime does not infer root, sudo or systemd mode.

Every config must contain:

```json
{"schemaVersion":1}
```

Unknown fields and unsupported schema versions fail closed.

## Secret ownership and rotation

Production should use file-backed secrets:

```text
GITLAB_API_TOKEN_FILE=/etc/codex-review/secrets/gitlab-api-token
GITLAB_WEBHOOK_SIGNING_TOKEN_FILE=/etc/codex-review/secrets/gitlab-webhook-signing-token
OPENAI_API_KEY_FILE=/etc/codex-review/secrets/openai-api-key
CODEX_REVIEW_NOTIFY_<REF>_WEBHOOK_FILE=/etc/codex-review/secrets/notify-<ref>-webhook
CODEX_REVIEW_NOTIFY_<REF>_SIGNING_SECRET_FILE=/etc/codex-review/secrets/notify-<ref>-signing-secret
```

A direct value and matching `_FILE` value are mutually exclusive. Secret files must be absolute paths, regular files and <=64 KiB. Rotate a credential by replacing the protected file atomically, running Doctor, then restarting the owning process. Isolated Runner keeps GitLab credentials on Controller and OpenAI/Codex credentials on Runner.

## Preflight

1. For native/systemd, install Node 22 >=22.22.2 or Node 24 >=24.19.0. For official Docker, host Node is irrelevant.
2. Install/authenticate the approved Codex CLI when using native/systemd; the release image contains its tested runtime.
3. Install a verified release tgz or verified OCI image.
4. Confirm GitLab is >=14.6.1. Do not treat compatibility with an old GitLab as a recommendation to leave it unpatched indefinitely.
5. Create Config Schema 2 file.
6. Provision file-backed secrets.
7. Run `npm run doctor`; record GitLab version/profile.
8. Require `/health/ready` = 200 before enabling webhooks.
9. Check `/health/dependencies` separately for GitLab/scope health.
10. Record `/version` in deployment evidence.

## GitLab profile operations

Doctor deterministically selects one provider profile from authenticated GitLab `/api/v4/version`:

```text
14.6.1 .. <15.7   Classic   /changes + overflow === false
>=15.7             Modern    /diffs pagination + /versions + exact real_size
```

There is no operator override. If Classic reports `overflow: true` or does not provide an explicit safe overflow signal, the review must block. If Modern pagination/version/size proof is incomplete, the review must block. Never bypass these checks to force a verdict from partial evidence.

The real system matrix permanently exercises 14.6.1, 17.11.7 and 19.3.0. Production acceptance must still cover the actual instance's permissions, configured diff limits and network policy.

## Health model

```text
/health/live
    process is alive

/health/ready
    database usable
    synchronous=FULL
    workers/publishers/notifiers available
    durable review queue has intake capacity

/health/dependencies
    GitLab reachability/version/profile
    GitLab circuit state
    project-scope refresh health
```

A temporary GitLab outage does not automatically make durable webhook intake unavailable. This prevents an ingress/load-balancer readiness reaction from discarding events the local database can still safely accept. Initial startup still fails closed because scope resolution and Codex capability probe happen before listening.

## Multi-repository scope

`gitlab.projects` and `gitlab.groups` define the supported scope. `includeSubgroups=true` expands subgroup projects through paginated Group Projects API.

Scope refresh is atomic: the active Set changes only after complete discovery. On provider/pagination failure, the last complete Set remains and dependency health degrades. A removed project is immediately unauthorized for new work and pending publications are canceled before another GitLab mutation.

## Durable state and recovery

Three stages are intentionally independent:

```text
Review Queue
    ↓
Review Run + Receipt
    ↓
GitLab Publication Outbox

Review Run / terminal review failure
    ↓
Notification Outbox
```

Recovery invariants:

- `running` Review Jobs requeue after process restart.
- `publishing` GitLab actions return to pending.
- `delivering` notifications return to pending.
- publication/notification retry never reruns a persisted Codex review.
- stale/out-of-scope publication is canceled.
- delayed `running` status cannot overwrite terminal state.
- same MR work is serialized; different MRs may run concurrently.

Never delete queue/outbox rows as an incident workaround.

## Fatal runtime behavior

`unhandledRejection` and `uncaughtException` are fatal integrity events. The process logs metadata-only error identity, stops HTTP intake, stops workers, flushes telemetry, checkpoints SQLite, closes state and exits non-zero. systemd/Docker restarts the process; durable recovery then restores interrupted stages.

Do not change this back to “log and keep running” without proving all service invariants remain valid after an unknown asynchronous failure.

## Admin control plane

The CLI is the supported operator mutation boundary. Direct SQL editing is not.

```bash
npm run admin -- status
npm run admin -- jobs [limit]
npm run admin -- publications [limit]
npm run admin -- notifications [limit]
npm run admin -- retry-publication <id>
npm run admin -- retry-notification <id>
npm run admin -- drain [seconds]
npm run admin -- reconcile
npm run admin -- db-check
npm run admin -- backup /secure-backup/review.sqlite
npm run admin -- backup-verify /secure-backup/review.sqlite
npm run admin -- restore-check /secure-backup/review.sqlite
npm run admin -- diagnostics
```

Retry commands only transition terminal `failed` outbox rows back to pending and reset retry metadata. They do not create a new Review Run.

## Backup and restore

The Node SQLite online backup API is the canonical backup path and is available on both supported runtime lines at the v5.1 minimum versions.

```bash
npm run admin -- backup /secure-backup/codex-review-$(date +%F-%H%M%S).sqlite
npm run admin -- backup-verify /secure-backup/codex-review-2026-08-25.sqlite
```

A backup is accepted only if all checks pass:

- `PRAGMA quick_check = ok`
- `PRAGMA foreign_key_check` has zero violations
- `PRAGMA user_version = 5`

Restore procedure:

1. Stop Controller.
2. Verify the backup with `restore-check`.
3. Preserve the failed/current database for forensic use.
4. Restore the verified SQLite file into the configured state directory with owner-only permissions.
5. Start the service.
6. Require Doctor, `/health/ready`, `/version`, queue/outbox counts and remote GitLab convergence checks.

Codex authentication state and external secret files are separate credential assets and are not contained in the SQLite backup.

### DR objectives

The project does not claim a universal numeric RPO/RTO because host backup cadence and Codex/GitLab availability are deployment-specific. Operators must define local objectives and run a restore drill at least after meaningful persistence/runtime changes. CI permanently exercises online backup, verification and recovery primitives on the Node compatibility floor.

## Monitoring and SLO primitives

Alert on:

- `/health/ready` failure
- dependency health degradation
- `codex_review_scope_healthy == 0`
- queue/outbox depth
- `codex_review_oldest_queue_age_seconds`
- `codex_review_oldest_publication_age_seconds`
- `codex_review_oldest_notification_age_seconds`
- worker saturation
- repeated retry exhaustion
- GitLab circuit opens
- token budget pressure
- state filesystem capacity/WAL growth

Recommended service-level objectives should be built from:

- webhook durable acceptance availability
- queue waiting latency
- review terminal completion availability
- time-to-terminal-verdict
- GitLab publication convergence latency

Do not label metrics by repository name, branch, prompt or source path. `/metrics` exposes low-cardinality product identity (`serviceVersion`, config/database schema and Safe Core commit).

## Capacity validation

Before materially increasing scope or concurrency, load-test the real deployment with representative MR sizes. Measure:

```text
project count
MR arrival burst
oldest queue age
review concurrency
Codex latency/token use
SQLite write latency/WAL size
publication convergence
CPU/memory/filesystem
```

Raise limits only after observing the bottleneck. PostgreSQL/HA is a future explicit replacement boundary, not a prerequisite for a reliable production deployment.

## Upgrade contract

Schema 5 is the first supported production database and Config Schema 2 is the first supported configuration schema.

**After v5.0.0, hard deletion of released persistence/config compatibility is forbidden.** Any future schema change must include:

- explicit version transition
- migration implementation
- fixtures created by the previous released schema
- forward upgrade test
- interruption/retry test
- backup-before-upgrade requirement
- documented rollback boundary

A rollback that would require reading a newer irreversible schema must be declared unsupported before deployment. Release notes must state the exact boundary.

Normal upgrade:

```bash
npm run admin -- backup /secure-backup/pre-upgrade.sqlite
npm run admin -- drain 120
# install verified tgz or switch to verified OCI digest
npm run doctor
sudo systemctl restart codex-review-runner   # isolated only
sudo systemctl restart codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
curl -fsS http://127.0.0.1:8787/version
```

GitLab server upgrades are independent infrastructure changes. Existing compatible 14.6.1+ environments do not need a cross-major GitLab upgrade merely to deploy the Service. When upgrading GitLab, follow GitLab's required stops/background migrations and re-run Doctor + a disposable MR acceptance test afterward.

## Docker production deployment

Do not rebuild source on the production host. Release produces:

```text
codex-review-service-<version>.tgz
SBOM.spdx.json
IMAGE_DIGEST.txt
compose.release.yaml
SHA256SUMS
GitHub provenance attestations
GHCR multi-arch image
```

`compose.release.yaml` pins `image:` to the canonical OCI digest. Compose secrets map required credentials into `/run/secrets/*`. The container remains canonical Node 24.19 even though native deployments support Node 22 LTS.

## Common incidents

### GitLab unavailable / rate-limited

Confirm `/health/ready` may remain available while `/health/dependencies` reports degraded. Restore connectivity and let bounded/circuit-protected queues drain. Do not disable durable intake solely because remote publication is delayed.

### GitLab Classic diff overflow

If Doctor reports `profile: classic` and a review blocks on diff completeness, inspect GitLab's `/changes` overflow condition and local diff limits. Do not force review of partial changes. Reduce MR size or deliberately adjust GitLab limits only after evaluating server memory/performance impact.

### Publication queue grows

Inspect token permission, status target project/ref/pipeline and 429/5xx behavior. Retry a terminal failed action only through Admin CLI after the cause is fixed.

### Notification queue grows

Inspect route Secret file, provider host, signature settings, timeout/429/5xx. Notification state never changes Review Verdict.

### Codex CLI incompatible

Install the tested CLI version or intentionally update the version policy only after Safe Contract capability validation. Do not add legacy argument fallbacks.

### Queue full

`/health/ready` becomes unavailable when the durable review queue reaches configured capacity. Reduce intake/load or safely increase capacity after measurement.

### Database integrity check fails

Stop the Controller, preserve the state directory, validate a known-good backup and restore. Do not run ad-hoc repair SQL against the only copy.

## Release gate

Before release require all of the following:

- product-contract verification
- `git diff --check`
- Node 22.22.2 + Node 24.19.0 CI and Release tests
- unit/fuzz/governance tests including Classic/Modern fail-closed contracts
- Docker build/smoke with pinned canonical Node 24.19 digest
- backup/recovery gate on the Node compatibility floor
- real GitLab CE 14.6.1 + 17.11.7 + 19.3.0 provider matrix
- production dependency audit + CodeQL
- package boundary dry-run
- OCI multi-arch build and High/Critical vulnerability scan
- package SBOM + OCI SBOM/provenance
- immutable tag/image/release behavior
- checksum + attestation verification instructions
- bilingual documentation consistency
- no scattered version fallbacks or temporary migration residue

## Repository governance

CI actions are immutable full-SHA pinned. Release changes are reviewed through PR and squash merge. Temporary branches are removed after merge. Safe Core remains exact commit-pinned; service-only compatibility/operations/OCI/notification features must not leak into shared protocol layers.

## v6.0.0 Config Schema 2 hard cut

Service 6.0.0 is a breaking configuration release. Config Schema 1 is not accepted by the runtime. Before restarting 6.0.0, rewrite the configuration to `schemaVersion: 2` and replace the removed Assignee-only fields with `review.triggerAssignment`. To preserve the old automatic Assignee gate, use `{"mode":"assignee","userIds":[...]}`. The recommended new deployment uses `{"mode":"reviewer","userIds":[]}` or explicit Reviewer IDs. The manual `/codex review` command is always an explicit assignment-gate bypass in v6; there is no compatibility equivalent for the removed `manualReviewBypassAssignee: false`.

Rollback to v5 requires restoring a matching Config Schema 1 file before starting the v5 binary. There is intentionally no runtime Schema 1 parser, silent translation, dual-read path, or compatibility flag in v6.

