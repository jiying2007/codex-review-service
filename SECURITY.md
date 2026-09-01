# Security Policy

## Product and Safe Core contract

Codex Review Service **7.3.0** owns production operations while shared safety, review-profile, Test Impact, diagnosis, Judgment Lifecycle, Codex Runtime and Provider primitives remain in exact-pinned Safe Core Family v4.

Machine-checked security identity lives in `product-contract.json`: Database Schema 8, Config Schema 7, Policy Schema 4, Review Receipt 5, Safe Contract 2, Runtime/Provider Contract v2, Node 22.22.2+/24.19.0+ LTS support, GitLab compatibility floor 14.6.1, and exact Safe Core commit `7878dae982088746c06e4fe747b2468e6af274a2`.

Service-only GitLab compatibility, CI artifact acquisition, IM, Docker, Admin/DR and deployment semantics must not leak into Safe Core.

## Trust model

One Service instance is one administrative/security **trust domain**. Projects covered by the same instance share Controller state, capacity and normally a GitLab credential domain. Use separate instances for materially different administrators, confidentiality or AI-data-policy domains.

## Configuration boundary

There is one non-secret **Config Schema 7** model. Direct-user mode uses `${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json`; system deployment uses `/etc/codex-review/config.json`. Unknown fields or unsupported schema versions fail closed.

Config Schema 7 adds Provider Contract v2 controls: `codex.credentialSource=auto|env|auth-json` and explicit `codex.allowInsecureHttp`. Non-loopback HTTP remains denied unless an operator explicitly opts in for a trusted relay; repository policy cannot provide credentials or weaken transport. Config Schema 6 remains the historical responsibility-notification boundary, while Config Schema 5 removed `review.incrementalReviewEnabled`; persistent model Judgment reuse is not configurable. Analyzer evidence remains configured only through bounded `review.analyzerReports`; profile selection uses the versioned Profile Pack; Test Impact produces recommendations only.

Secrets are never stored in service JSON or SQLite. Production should use protected `_FILE` inputs such as `GITLAB_API_TOKEN_FILE`, `GITLAB_WEBHOOK_SIGNING_TOKEN_FILE` and `OPENAI_API_KEY_FILE`; compatible-provider credentials may instead remain in the configured Codex home `auth.json`, where Core accepts only `auth_mode=apikey` with a non-empty `OPENAI_API_KEY`. Secret values are not copied into argv, receipts, diagnostics or repository policy.

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

The Admin CLI is the supported mutation boundary. Current backup acceptance requires `quick_check=ok`, zero foreign-key violations and exact Database Schema 8.

The historical **Schema 5 -> 6** and **Schema 6 -> 7** database migrations remain explicit and tested. **Schema 7 -> 8** adds durable status-card state with the same source-integrity, mode-0600 verified-backup, transactional-DDL and post-migration verification boundary. Config Schema 6 -> 7 is a configuration hard cut for Provider Contract v2 and has no runtime translation. Any DB/Config schema change requires explicit migration fixtures and a documented rollback boundary.

Service 7.0.0 introduced a Config Schema 4 -> 5 configuration hard cut; Service 7.2.0 introduced Config Schema 5 -> 6; Service 7.3.0 introduces Config Schema 6 -> 7. Rollback to an older configuration schema requires restoring the matching release configuration. Never assume an older binary can translate a newer configuration or irreversible database schema.

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
