# Operations Runbook

## Product baseline

Codex Review Service **7.1.0** is the current production-operations baseline. Machine-readable identity lives in `product-contract.json`:

- Database Schema 8
- Config Schema 5
- Policy Schema 4
- Review Receipt 5
- Safe Contract 2 / Safe Core Family v4 exact commit `8375907712db37492aff1ac0d0013e2753b1f6ab`
- Profile Pack 1 / Test Impact 1 / Analyzer Adapter 1
- Native/systemd Node.js: 22 LTS >=22.22.2 or 24 LTS >=24.19.0; Node 23 unsupported
- Canonical Docker Node.js: 24.19.0
- GitLab Self-Managed compatibility floor: >=14.6.1
- GitLab recommendation: vendor-supported release

The service owns GitLab provider semantics, immutable `start_sha`/`head_sha` evidence, CI artifact acquisition/adapters, SQLite Schema 8, durable Review Queue, GitLab Publication Outbox, Notification Outbox, telemetry and deployment. Shared safety/profile/test-impact primitives remain in exact-pinned Safe Core.

## Deployment model

This remains a **single-node stateful service** backed by local SQLite `WAL + synchronous=FULL`. Use exactly one active Controller per database and never place the database on NFS/SMB/network filesystems.

- Direct user mode: XDG config/state defaults.
- Standard system deployment: one Controller with inline Codex.
- Hardened deployment: Controller + isolated Unix-socket Runner.
- Docker/Compose: release OCI digest with canonical Node 24.19.0.

One instance is one administrative/security **trust domain**. Separate instances are preferred for different administrator, confidentiality or AI-data-policy domains.

## Configuration ownership

Direct user mode:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json
${XDG_STATE_HOME:-$HOME/.local/state}/codex-review/
```

System deployment:

```text
/etc/codex-review/config.json        Config Schema 5, non-secret
/etc/codex-review/secrets/*          protected secret files
/etc/codex-review-service.env        secret-file references + process selection
/var/lib/codex-review                SQLite/state
```

Both systemd units explicitly set `CODEX_REVIEW_CONFIG_FILE=/etc/codex-review/config.json`. Runtime does not infer root, sudo or systemd mode.

Config Schema 5 is the Judgment Lifecycle v1 hard boundary. It removes `review.incrementalReviewEnabled`; persistent model Judgment reuse is not configurable. Structured `review.analyzerReports`, versioned `review.profile`, and deterministic Test Impact remain explicit evidence inputs. Unknown fields and unsupported versions fail closed.

## Analyzer / Profile / Test Impact operations

`analyzerReports` is an operator-controlled list of already-produced CI artifacts. Supported adapters include SARIF, GitLab Code Quality, JUnit, Cobertura, LCOV, compiler diagnostics, Cppcheck, CycloneDX, Trivy and Gitleaks. The Service does **not** execute repository-defined analyzer commands.

Profile Pack v1 provides `general`, backend/frontend/security/C++ and embedded/driver/kernel/realtime review emphasis. Profile selection cannot weaken Safe Contract, evidence completeness or changed-line anchoring.

Test Impact reads candidate test paths at the exact MR head SHA and produces ranked recommendations only. It does not execute tests and never converts recommendations into test-pass evidence.

## Secret ownership and rotation

Production should use file-backed secrets:

```text
GITLAB_API_TOKEN_FILE=/etc/codex-review/secrets/gitlab-api-token
GITLAB_WEBHOOK_SIGNING_TOKEN_FILE=/etc/codex-review/secrets/gitlab-webhook-signing-token
OPENAI_API_KEY_FILE=/etc/codex-review/secrets/openai-api-key
CODEX_REVIEW_NOTIFY_<REF>_WEBHOOK_FILE=/etc/codex-review/secrets/notify-<ref>-webhook
CODEX_REVIEW_NOTIFY_<REF>_SIGNING_SECRET_FILE=/etc/codex-review/secrets/notify-<ref>-signing-secret
```

Direct and `_FILE` values are mutually exclusive. Rotate credentials atomically, run Doctor, then restart the owning process.

## Preflight

1. Install/verify the exact release artifact.
2. Create Config Schema 5.
3. Provision protected secret files.
4. Run `npm run doctor`; record GitLab version/profile and Codex runtime readiness.
5. Require `/health/ready` = 200 before enabling webhook traffic.
6. Check `/health/dependencies` independently.
7. Record `/version` in deployment evidence.

## GitLab profile operations

```text
14.6.1 .. <15.7   Classic   /changes + overflow === false
>=15.7             Modern    /diffs pagination + /versions + exact real_size
```

There is no operator override. Incomplete provider evidence blocks Review. Real system CI covers GitLab CE 14.6.1, 17.11.7 and 19.3.0.

## Health model

```text
/health/live
    process alive

/health/ready
    local durable intake safe

/health/dependencies
    GitLab/version/profile/scope dependency health

/version
    machine product/runtime identity
```

A temporary GitLab outage does not automatically make durable local intake unavailable. Initial startup still fails closed when required capability/scope initialization cannot complete.

## Durable state and recovery

Three durable stages are independent:

```text
Review Queue
   ↓
Review Run + Receipt
   ├─ GitLab Publication Outbox
   └─ Notification Outbox
```

Recovery invariants:

- `running` jobs requeue after restart.
- `publishing` GitLab actions return to pending.
- `delivering` notifications return to pending.
- publication/notification retry never reruns a persisted Codex review.
- stale/out-of-scope publication is canceled.
- same-MR work is serialized.

Never delete queue/outbox rows as an incident workaround.

## Fatal runtime behavior

`unhandledRejection` and `uncaughtException` are fatal integrity events. The process stops intake/workers, flushes telemetry, checkpoints/closes SQLite and exits non-zero. systemd/Docker restarts it and durable recovery resumes interrupted work. Do not turn this into “log and keep running”.

## Admin control plane

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

Retry commands only move terminal failed outbox rows back to pending; they do not create a new Review Run.

## Backup and restore

The Node SQLite online backup API is the canonical backup path.

```bash
npm run admin -- backup /secure-backup/codex-review-$(date +%F-%H%M%S).sqlite
npm run admin -- backup-verify /secure-backup/codex-review-2026-08-29.sqlite
```

A current backup is accepted only if:

- `PRAGMA quick_check = ok`
- `PRAGMA foreign_key_check` has zero violations
- `PRAGMA user_version = 7`

The historic **Schema 5 -> 6 migration** remains a supported explicit migration path: source integrity verification, mode-0600 backup, transactional DDL/data transition and post-migration verification.

Restore procedure:

1. Stop Controller.
2. Verify the backup with `restore-check`.
3. Preserve current/failed DB for forensics.
4. Restore the verified SQLite file with owner-only permissions.
5. Start the service.
6. Require Doctor, `/health/ready`, `/version` and queue/outbox convergence.

## Upgrade and rollback

From v5.0.0 onward, released DB/Config compatibility is a product contract. Service 7.1.0 uses Config Schema 5 and Database Schema 8; startup migrates Schema 7 only after a verified backup. Service 7.0.0 introduced the Config Schema 4 -> 5 hard cut, and runtime never translates Config Schema 4. Before upgrade:

1. create/verify backup;
2. drain durable work;
3. rewrite Config Schema 5 and remove `incrementalReviewEnabled`;
4. verify release tgz/OCI digest/provenance;
5. install exact release;
6. run Doctor before traffic;
7. verify health/version/queues.

Rollback requires the exact older release artifact, its matching configuration schema and any database backup required by that release. Never run a binary against a configuration schema it does not own and assume translation.

## Monitoring and SLO primitives

Alert on:

- `/health/ready` failure
- dependency health degradation
- `codex_review_scope_healthy == 0`
- queue/outbox depth
- `codex_review_oldest_queue_age_seconds`
- `codex_review_oldest_publication_age_seconds`
- `codex_review_oldest_notification_age_seconds`
- worker saturation / retry exhaustion
- GitLab circuit opens
- token budget pressure
- state filesystem capacity/WAL growth

Recommended SLOs are built from durable webhook acceptance, queue waiting latency, review completion availability, **time-to-terminal-verdict**, and GitLab publication convergence latency.

Do not label metrics by repository name, branch, source path, prompt or secret.

## Capacity and DR

The project does not claim universal numeric RPO/RTO. Operators define backup cadence and run restore drills after meaningful persistence/runtime changes. Scale tests should validate queue age, time-to-terminal-verdict, SQLite/WAL growth, API rate limits and Codex token pressure before increasing concurrency.
