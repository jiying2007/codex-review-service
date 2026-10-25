# Operations Runbook

## Product baseline

Codex Review Service **7.6.2** is the current production-operations baseline. Machine-readable identity lives in `product-contract.json`:

- Database Schema 10
- Config Schema 8
- Model Routing Contract 1
- Policy Schema 4
- Review Receipt 5
- Safe Contract 2 / Safe Core Family v4 exact commit `190651770a444b0693d82228afc66879dd57b0c0`
- Profile Pack 1 / Test Impact 1 / Analyzer Adapter 1
- Native/systemd Node.js: 22 LTS >=22.22.2 or 24 LTS >=24.19.0; Node 23 unsupported
- Canonical Docker Node.js: 24.19.0
- GitLab Self-Managed compatibility floor: >=14.6.1
- GitLab recommendation: vendor-supported release

The service owns GitLab provider semantics, immutable `start_sha`/`head_sha` evidence, CI artifact acquisition/adapters, SQLite Schema 10, durable Review Queue, GitLab Publication Outbox, Notification Outbox, telemetry and deployment. Shared safety/profile/test-impact primitives remain in exact-pinned Safe Core.

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
/etc/codex-review/config.json        Config Schema 8, non-secret
/etc/codex-review/secrets/*          protected secret files
/etc/codex-review-service.env        secret-file references + process selection
/var/lib/codex-review                SQLite/state
```

Both systemd units explicitly set `CODEX_REVIEW_CONFIG_FILE=/etc/codex-review/config.json`. Runtime does not infer root, sudo or systemd mode.

Config Schema 8 is the current boundary. Service 7.6.2 consumes Runtime/Provider Contract v3 and Model Routing Contract v1; legacy `codex.model`/`codex.fastModel` are rejected rather than translated. Unknown fields and unsupported versions still fail closed.

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
2. Create Config Schema 8 and verify Runtime/Provider Contract v3 auto resolution or the explicitly selected advanced override.
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
- `publishing` GitLab actions return to pending unless a commit-status transport may already have started. Those status attempts recover as `uncertain` and enter readback reconciliation.
- `delivering` notifications return to pending.
- publication/notification retry never reruns a persisted Codex review.
- stale/out-of-scope publication is canceled.
- same-MR work is serialized.

Never delete queue/outbox rows as an incident workaround.

### Commit-status uncertainty and merge enforcement

The durable Review Job, Run and Receipt record the Service verdict. A GitLab commit status is a remote projection of that verdict. Status requests for one source project, SHA, ref and status name share one local publication order, including implicit and explicit pipeline targets. The publisher checks the latest durable generation immediately before each HTTP send.

A timeout or lost response does not prove that the remote request stopped. An older accepted request can still finish after a newer status has been acknowledged. Database Schema 10 records each transport attempt in `status_write_attempts` before sending it, including each internal `409` retry. A definite HTTP rejection is recorded separately from an unknown result. A crash with an unfinished intent recovers as `uncertain`. The shared uncertainty domain includes the GitLab API URL, status project, SHA, ref and status name; it spans MR IDs and implicit/explicit pipeline aliases.

`status_publication_targets` retains the latest durable generation, acknowledgement ID, next readback time, last observation and repair count. While any older request in this domain has an unknown result, the current outbox remains `uncertain`, even after a successful new POST or a matching GET. A matching read only describes the current remote projection. It does not clear an unknown attempt, and it does not issue another POST. Normal acknowledged writes with no known uncertainty retain the existing `published` behavior and do not add a readback loop.

The publisher reconciles uncertain targets using its existing worker concurrency, rate limiter and bounded retry backoff. It repairs only a complete, unambiguous read showing the latest target is missing or mismatched, after rechecking the current generation and MR snapshot and checking generation again immediately before transport. A queued reconciliation claim cannot act on a different or already published generation after it acquires the shared status lock. Repair cycles are durably capped by `publication.maxAttempts` for each latest outbox item; internal `409` retries remain separately bounded. The `repaired` count and `repairAcknowledged` observation describe a repair response with a valid acknowledgement ID; they never resolve an older unknown request. Matched targets are only observed at `lifecycle.reconcileIntervalMs`. Stop requests prevent new repair writes. This process reuses persisted review output and never reruns Codex.

Exact automatic readback currently requires an explicit pipeline ID and GitLab 17.9 or later, which added pipeline filtering to the status-list API. It validates project endpoint, SHA, ref, name, pipeline and the authenticated bot, and records whether the returned status ID matches the acknowledged ID. Missing identity, incomplete pagination, duplicate candidates, an implicit pipeline or an older provider remains uncertain without a repair POST. GitLab 14.6.1 remains supported for ordinary operation; this conservative recovery boundary does not raise the product compatibility floor. The existing 14.6.1 / 17.11.7 / 19.3.0 real Docker provider matrix includes acceptance checks for these paths. See the [GitLab commit-status API](https://docs.gitlab.com/api/commits/#list-commit-statuses).

GitLab's native approvals and protected-branch rules remain the merge authority. If this status participates in merge enforcement, an independent trusted server-side veto must reject unresolved publication uncertainty and stale or incomplete review evidence. A result of `not_vetoed` means only that this additional check has no current objection; it does not approve a merge, bypass GitLab checks or perform a merge. This Service supplies the durable evidence ledger, but does not currently supply that veto adapter or a GitLab conditional-generation write capability.

A strict veto integration must meet all of these requirements:

- Bind the actual server-side operation to the configured GitLab instance, project/MR, source project/ref and exact head/start/base SHAs, the status project/ref/name, and the target ref's expected old and proposed new object IDs. Use trusted server context, not a caller-selected older job or a status label.
- Read the latest applicable review job and publication generation together with the durable uncertainty ledger. A newer review of the same SHA must not be hidden by an earlier published target. Missing identity/evidence, an unfinished or blocking review, a pending publication, or any applicable `started`/`uncertain` attempt must veto. Include shared cross-MR/pipeline status domains and orphan/global uncertainty. A matching GET, an acknowledgement of a different attempt or elapsed time cannot resolve an unknown attempt.
- Bind the decision to the ref update through a trusted serialization or conditional-consumption protocol. A generation change or new unknown write between checking and committing the ref must invalidate the decision. The protocol must cover every permitted merge/ref-write path and retain a veto after an indeterminate operation until authoritative server evidence resolves it; a time-limited response or client lock is insufficient.

A one-time GET, a successful required pipeline, or a `pre-receive` check that releases its coordination before the ref update leaves a check-to-commit race. These can be preliminary checks, but cannot be presented as the strict fence above. In particular, the local `/health/ready` response is cached intake health, not an MR-specific veto decision. The GitHub `CI Gate` in this repository checks the Service build and is not a gate in a customer's GitLab project.

GitLab 14.6.1 Self-Managed supports [server hooks without a paid tier](https://github.com/gitlabhq/gitlabhq/blob/v14.6.1/doc/administration/server_hooks.md); installing them is a separately authorized GitLab-server administration task. That version supports `pre-receive`, `update` and `post-receive` custom hooks, not an assumed `reference-transaction.d` integration. [Required pipelines](https://github.com/gitlabhq/gitlabhq/blob/v14.6.1/doc/user/project/merge_requests/merge_when_pipeline_succeeds.md) also do not supply Service-generation fencing, and merge-request pipelines can take precedence over branch pipelines. The existing 14.6.1 / 17.11.7 / 19.3.0 Docker matrix qualifies provider operations and readback, not a server-side veto adapter. A future adapter needs real-version acceptance for unknown-write rejection, same-SHA generation changes during the ref update, and fail-closed recovery before strict merge enforcement can be claimed. No deployment host, hook installation, credential or topology is inferred from this requirement.

After overlapping generations and an uncertain HTTP outcome, hold automated merge for the affected source snapshot through an independent control. Retain job/outbox/attempt IDs, source SHA, start SHA, ref and pipeline IDs; inspect the two status tables in a verified database backup and investigate the outstanding request in provider-side records. Unknown attempts, their source jobs and the latest desired verdict survive ordinary retention, restart and backup/restore. Legacy rows with a missing job are retained as `ELEGACYSTATUSORPHAN` with a null job identity and cannot authorize a repair. If a legacy target itself is incomplete, its unknown scope conservatively prevents stable publication across the store. Previously discarded legacy history cannot be reconstructed.

There is deliberately no command that converts a matching observation, elapsed timeout or reset retry counter into proof that an old handler stopped. Deleting an attempt, restoring an older DB or restarting is not a valid uncertainty-resolution procedure. `admin status` and `admin diagnostics` expose `statusWrites` counts; `admin drain` reports incomplete while unknown attempts or uncertain publications remain. Metrics expose `codex_review_status_unknown_writes` and `codex_review_status_uncertain_targets`. Final notifications show uncertainty after the existing publication barrier timeout. `admin reconcile` still discovers review work; the publisher workers own status readback. `/health/ready` includes `publicationUncertainty` while continuing to describe durable local intake, not merge authority.

Before rollback from Schema 10, stop the controller, retain the current DB and its attempt ledger, and establish an independent merge hold and provider-side quiescence/fencing for unknown requests. The verified Schema 9 migration backup is a data rollback boundary; it cannot revoke an already accepted HTTP request. Older binaries reject Schema 10, and an in-place schema downgrade is unsupported.

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
- `PRAGMA user_version = 8`

The historic **Schema 5 -> 6 migration** remains a supported explicit migration path: source integrity verification, mode-0600 backup, transactional DDL/data transition and post-migration verification.

Restore procedure:

1. Stop Controller.
2. Verify the backup with `restore-check`.
3. Preserve current/failed DB for forensics.
4. Restore the verified SQLite file with owner-only permissions.
5. Start the service.
6. Require Doctor, `/health/ready`, `/version` and queue/outbox convergence.

## Upgrade and rollback

From v5.0.0 onward, released DB/Config compatibility is a product contract. Service 7.6.2 uses Config Schema 8 and Database Schema 10 while consuming Runtime/Provider Contract v3 and Model Routing Contract v1; the hard cut retires `codex.model`/`codex.fastModel`. Service 7.2.x used Config Schema 6 for responsibility delivery, and Service 7.0.0 introduced the historical Config Schema 4 -> 5 hard cut. Before upgrade:

1. create/verify backup;
2. drain durable work;
3. rewrite Config Schema 8, retain the removal of `incrementalReviewEnabled`, preserve verified identity mappings, and explicitly choose Provider credential/HTTP policy;
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
