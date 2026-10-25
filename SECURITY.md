# Security Policy

## Product and Safe Core contract

Codex Review Service **7.6.2** owns production operations while shared safety, review-profile, Test Impact, diagnosis, Judgment Lifecycle, Codex Runtime and Provider primitives remain in exact-pinned Safe Core Family v4.

Machine-checked security identity lives in `product-contract.json`: Database Schema 10, Config Schema 8, Policy Schema 4, Review Receipt 5, Safe Contract 2, Runtime/Provider Contract v3, Model Routing Contract v1, Node 22.22.2+/24.19.0+ LTS support, GitLab compatibility floor 14.6.1, and exact Safe Core commit `190651770a444b0693d82228afc66879dd57b0c0`.

Service-only GitLab compatibility, CI artifact acquisition, IM, Docker, Admin/DR and deployment semantics must not leak into Safe Core.

## Trust model

One Service instance is one administrative/security **trust domain**. Projects covered by the same instance share Controller state, capacity and normally a GitLab credential domain. Use separate instances for materially different administrators, confidentiality or AI-data-policy domains.

## Configuration boundary

There is one non-secret **Config Schema 8** model. Direct-user mode uses `${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json`; system deployment uses `/etc/codex-review/config.json`. Unknown fields or unsupported schema versions fail closed.

Config Schema 8 consumes Provider Contract v3 and Model Routing Contract v1. Provider credentials and transport remain operator-owned; repository policy cannot provide credentials, select a provider/model, or weaken transport. Model routing uses the Schema 8 Auto/Preference/Fixed policy and same-provider role controls; legacy `codex.model`/`codex.fastModel` are rejected rather than translated. Non-loopback HTTP remains denied unless an operator explicitly opts in for a trusted relay. Persistent model Judgment reuse is not configurable. Analyzer evidence remains configured only through bounded `review.analyzerReports`; profile selection uses the versioned Profile Pack; Test Impact produces recommendations only.

Secrets are never stored in service JSON or SQLite. Production should use protected `_FILE` inputs such as `GITLAB_API_TOKEN_FILE`, `GITLAB_WEBHOOK_SIGNING_TOKEN_FILE` and `OPENAI_API_KEY_FILE`; compatible-provider credentials may instead remain in the configured Codex home `auth.json`, where Core accepts only `auth_mode=apikey` with a non-empty `OPENAI_API_KEY`. Secret values are not copied into argv, receipts, diagnostics or repository policy.

File-backed secrets resolve to regular files of at most 64 KiB. The service opens the path once, checks and reads that same descriptor with a fixed byte ceiling, checks its final size, and closes it on success or failure. Mounted files, group-readable files, read-only Docker secrets and file symlinks remain supported. Replacing a pathname or symlink after opening cannot redirect that read; protect the file and its parent directories against concurrent in-place writes, and use atomic replacement for rotation. The descriptor binding does not promise an immutable snapshot of a file modified in place.

## Judgment lifecycle security boundary

Every new review event builds current evidence and performs a fresh Judgment for that event. Durable historical findings, resolutions, or prior verdicts may support lineage and reporting only after fresh review; they cannot be merged into a new Judgment or verdict. Webhook delivery idempotency is delivery-scoped and does not define review identity. Review Receipt v5 binds the exact ReviewSubject and Evidence Manifest identity.

## Analyzer artifact security boundary

Analyzer Adapter Hub consumes **already-produced GitLab CI artifacts** only. Supported adapters include SARIF, GitLab Code Quality, JUnit, Cobertura, LCOV, compiler diagnostics, Cppcheck, CycloneDX, Trivy and Gitleaks.

The Service never executes repository-defined analyzer commands, scripts or commands embedded in report text. Artifact size is bounded. Finding-like evidence is normalized through the Safe Core Analyzer Finding contract; coverage, SBOM and other metadata-only evidence is not fabricated into source findings. Evidence is bound to the exact MR head pipeline and changed-line validation remains Controller-owned.

## GitLab capability security boundary

Compatibility is capability-driven rather than scattered version fallback code.

### Diff completeness

- GitLab 14.6.1 to <15.7 uses the **Classic** `/changes` contract and proceeds only when GitLab explicitly reports `overflow: false`.
- GitLab >=15.7 uses the **Modern** paginated `/diffs` plus `/versions.real_size` proof.

If the Service cannot prove complete MR coverage, Review fails closed before Codex produces a trusted verdict.

### Webhook authentication

GitLab versions expose two different security capabilities:

- **GitLab <19.1 — Classic token mode.** GitLab sends `X-Gitlab-Token`. The Service compares the configured `GITLAB_WEBHOOK_SIGNING_TOKEN` value in constant time and derives deterministic delivery identity from the event type plus SHA-256 of the exact raw request body. These GitLab versions do not provide the Standard Webhooks timestamp/HMAC replay-window contract, so production should additionally use trusted HTTPS/private ingress and network source restrictions where available.
- **GitLab >=19.1 — Standard HMAC mode.** The Service requires provider delivery identity, timestamp replay window, HMAC-SHA256 over the exact raw body, expected GitLab instance and constant-time signature verification.

Doctor reports `webhookAuth`, `webhookReplayWindow` and provider profile so deployment evidence records the actual security level.

## Project scope and durable acknowledgement

Only explicit `gitlab.projects` and `gitlab.groups` are supported. Group discovery must exhaust pagination before replacing active scope. Failed refresh preserves the last complete scope and degrades dependency health.

SQLite uses a local filesystem with WAL + `synchronous=FULL`. Review execution, GitLab publication and IM notification are independent durable failure domains. Publication or notification retries operate on persisted outputs and do not create a new Review Run.

## Codex Safe Contract

Codex runs with the exact Safe Core capability contract, bounded output/time, read-only sandbox and filtered child environment. GitLab credentials are never forwarded to Codex. Untrusted MR, CI-log or analyzer content cannot grant tools, network, credentials or weaken Controller-owned policy.

## Storage, backup, migration and rollback

The Admin CLI is the supported mutation boundary. Current backup acceptance requires `quick_check=ok`, zero foreign-key violations and exact Database Schema 10.

The historical **Schema 5 -> 6**, **Schema 6 -> 7**, and **Schema 7 -> 8** database migrations remain explicit and tested. **Schema 8 -> 9** adds Finding Claim projection and immutable lifecycle state with the same source-integrity, mode-0600 verified-backup, transactional-DDL and post-migration verification boundary. **Schema 9 -> 10** adds durable status-write attempts and target uncertainty under the same verified additive migration process; unknown outcomes survive restart, retention and backup, and rollback must preserve their ledger and control outstanding remote writes. Config Schema 6 -> 7 is the historical Provider Contract hard cut; Config Schema 7 -> 8 is the Model Routing Contract v1 hard cut that retires `codex.model`/`codex.fastModel`. Any DB/Config schema change requires explicit migration fixtures and a documented rollback boundary.

Service 7.0.0 introduced a Config Schema 4 -> 5 configuration hard cut; Service 7.2.0 introduced Config Schema 5 -> 6; Service 7.3.0 introduced Config Schema 6 -> 7; Service 7.5.5 introduced Config Schema 7 -> 8. Rollback to an older configuration schema requires restoring the matching release configuration. Never assume an older binary can translate a newer configuration or irreversible database schema.

## Fatal integrity behavior

Unknown `unhandledRejection` and `uncaughtException` events trigger fatal metadata-only logging, graceful owned-resource shutdown, SQLite checkpoint/close and non-zero exit. systemd/Docker restart plus durable recovery owns continuation.

## Deployment hardening

System deployments should use non-login users, protected secret files, trusted TLS ingress and restricted health/metrics access. Docker release images run non-root, drop all capabilities, use `no-new-privileges`, a read-only root filesystem and a digest-pinned Node 24.19 base.

For Classic webhook mode, network controls are particularly important because the upstream GitLab version cannot provide timestamped HMAC replay protection. For explicitly allowed private-network Codex HTTP relays, operators must treat the network path as trusted and isolated; HTTPS remains the preferred transport.

## Supply chain

PR/release gates cover Node 22.22.2 and 24.19.0, unit/fuzz/governance tests, Docker build/smoke, backup/recovery, real GitLab CE 14.6.1/17.11.7/19.3.0 provider matrix, dependency audit, CodeQL, OCI vulnerability scanning, SBOM, checksums and provenance attestations.

Production should deploy verified release artifacts or the digest-pinned OCI image, never a mutable convenience tag as final identity.

## Reporting

Do not publish credentials, private source or exploitable details in public issues. Use GitHub private vulnerability reporting/security advisories when available.

## Publication and transport boundaries

Required analyzer artifacts are mandatory current evidence. Their acquisition/parse failure cannot be treated as an optional context failure. The final verdict includes current analyzer findings before display truncation.

Commit-status writes are bound to a durable review job generation and exact source SHA, start SHA, ref, source project and pipeline. Requests for the same source project, SHA, ref and status name share a local publication order even when their pipeline IDs differ or are implicit. The generation is checked again after throttling and before GitLab's 409 retry.

Database Schema 10 adds durable per-transport status intents and per-target uncertainty. Each actual send has a separate attempt record, including `409` retries; acknowledged or definitely rejected attempts cannot erase an earlier unknown result. Interrupted intents recover as unknown. A newer generation remains `uncertain` while its shared status domain contains an unknown attempt, even if a current read matches. Unknown records and the latest desired verdict survive retention, restart and backup. Missing legacy jobs remain explicit orphan uncertainty without an invented generation; incomplete legacy targets conservatively retain unknown scope.

The publisher's bounded reconciliation checks exact project/SHA/ref/name/pipeline and bot identity, records remote-ID correspondence, and repairs only a clear latest-target mismatch after checking generation and snapshot again. Matching observations never authorize repeated POSTs or clear unknown attempts. Older GitLab releases and insufficient target identity use a conservative fallback that retains uncertainty without automatic repair; ordinary GitLab 14.6.1 operations remain supported.

These mechanisms do not establish a remote generation fence. A timed-out POST can still finish after a newer request or after a successful readback. A trusted server-side veto must bind the exact MR/source snapshot and latest durable generation to the actual target-ref update and reject unresolved publication uncertainty. Checking once before the update is insufficient: a new generation or unknown write can appear between the check and the ref commit. Strict enforcement requires a trusted serialization or conditional-consumption protocol that closes that race and fails closed when the ref operation is indeterminate; neither pipeline success, a matching GET, a later ACK nor lease expiry supplies that proof.

The veto is an additional denial mechanism, not merge authority. A non-veto result must not approve or execute a merge or bypass GitLab's native approvals and protected-branch rules. This Service implements neither that server adapter nor its ref-transaction protocol. Its Review Receipt keeps non-blocked review readiness at `needs_evidence`, and `/health/ready` remains cached local intake health with uncertainty exposed separately. Neither is a merge authorization endpoint. Operating, integration and rollback boundaries are in [OPERATIONS.md](OPERATIONS.md#commit-status-uncertainty-and-merge-enforcement).

`admin publication-evidence PROJECT_ID MR_IID` provides a read-only, uncached local evidence inspection in one SQLite snapshot. It never consumes or resolves an attempt, contacts GitLab or loads transport credentials. It checks latest MR/shared-domain generations, receipt/current final publication identity, exact acknowledgements and unresolved or unadopted history. Unknown identity or protocol cannot supply positive evidence. Its bounded JSON omits finding text, descriptions, secrets and local database paths. Every result retains `mergeAuthorized: false` and `refTransactionBound: false`; exit `3` means only `evidence_complete_unbound`, while exits `1`/`2` mean error/blocked. There is no exit `0` permission result and no implied protection after the read transaction ends.

Every finding create carries a durable outbox write intent before HTTP transport. Known-claim retries bind that intent to the same bot, claim, finding and position and require a fresh remote reconciliation. If a remote write may have happened and no safe remote identity can reconcile it, publication fails with `ECLAIMPUBLISHUNCERTAIN`; changing bot identity, claim eligibility or retry counters does not authorize another create. This is a fail-closed uncertainty boundary, not a distributed exactly-once guarantee.

GitLab API redirects stay on the configured origin. Artifact downloads may follow signed CDN redirects without credentials, and credentials remain absent if redirected back. Writes, HTTPS downgrades, credential-bearing URLs and unbounded redirect chains are rejected.
