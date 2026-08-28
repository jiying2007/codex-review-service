# Security Policy

## Product and Safe Core contract

Codex Review Service **5.1.0** owns production operations while shared Codex/process execution remains in exact-pinned Safe Core Family v4.

Machine-checked security identity lives in `product-contract.json`: Database Schema 5, Config Schema 2, Policy Schema 3, Review Receipt 4, Safe Contract 2, Node 22.22.2+/24.19.0+ LTS support, GitLab compatibility floor 14.6.1, and exact Safe Core commit.

Service-only GitLab compatibility, IM, Docker, Admin/DR and deployment semantics must not leak into Safe Core.

## Trust model

One Service instance is one administrative/security **trust domain**. Projects covered by the same instance share Controller state, capacity and normally a GitLab credential domain. Use separate instances for materially different administrators, confidentiality or AI-data-policy domains.

## Configuration boundary

There is one non-secret Config Schema 2 model. Direct-user mode uses `${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json`; system deployment uses `/etc/codex-review/config.json`. Unknown fields or unsupported schema versions fail closed.

Secrets are never stored in JSON or SQLite. Production should use protected `_FILE` inputs such as `GITLAB_API_TOKEN_FILE`, `GITLAB_WEBHOOK_SIGNING_TOKEN_FILE` and `OPENAI_API_KEY_FILE`. Direct and file forms are mutually exclusive.

## GitLab capability security boundary

Compatibility is capability-driven rather than scattered version fallback code.

### Diff completeness

- GitLab 14.6.1 to <15.7 uses the **Classic** `/changes` contract and proceeds only when GitLab explicitly reports `overflow: false`.
- GitLab >=15.7 uses the **Modern** paginated `/diffs` plus `/versions.real_size` proof.

If the Service cannot prove complete MR coverage, Review fails closed before Codex produces a trusted verdict.

### Webhook authentication

GitLab versions expose two different security capabilities:

- **GitLab <19.1 — Classic token mode.** GitLab sends `X-Gitlab-Token`. The Service compares the configured `GITLAB_WEBHOOK_SIGNING_TOKEN` value in constant time and derives deterministic delivery identity from the event type plus SHA-256 of the exact raw request body. These GitLab versions do not provide the Standard Webhooks timestamp/HMAC replay-window contract, so production must additionally use trusted HTTPS/private ingress and network source restrictions where available.
- **GitLab >=19.1 — Standard HMAC mode.** The Service requires provider delivery identity, timestamp replay window, HMAC-SHA256 over the exact raw body, expected GitLab instance and constant-time signature verification.

The same `GITLAB_WEBHOOK_SIGNING_TOKEN(_FILE)` secret surface is retained in both modes. For Classic GitLab, configure that exact generated `whsec_...` value in GitLab's webhook **Secret Token** field; GitLab returns it in `X-Gitlab-Token`. For Standard mode, configure it as the Standard Webhooks Signing Token.

Classic compatibility does **not** claim the same anti-replay guarantee as Standard HMAC mode. Doctor reports `webhookAuth`, `webhookReplayWindow` and provider profile so deployment evidence records the actual security level.

## Project scope and durable acknowledgement

Only explicit `gitlab.projects` and `gitlab.groups` are supported. Group discovery must exhaust pagination before replacing active scope. Failed refresh preserves the last complete scope and degrades dependency health.

SQLite uses a local filesystem with WAL + `synchronous=FULL`. Review execution, GitLab publication and IM notification are independent durable failure domains. Retries never implicitly rerun a persisted Codex Review.

## Codex Safe Contract

Codex runs with the exact Safe Core capability contract, bounded output/time, read-only sandbox and filtered child environment. GitLab credentials are never forwarded to Codex. Untrusted MR content cannot grant tools, network, credentials or weaken Controller-owned policy.

## Storage, backup and rollback

The Admin CLI is the supported mutation boundary. Backup acceptance requires `quick_check=ok`, zero foreign-key violations and exact Schema 5. After v5.0.0, any DB/Config schema change requires explicit migration fixtures/tests and a documented rollback boundary. Never run an older binary against a newer irreversible schema.

## Fatal integrity behavior

Unknown `unhandledRejection` and `uncaughtException` events trigger fatal metadata-only logging, graceful owned-resource shutdown, SQLite checkpoint/close and non-zero exit. systemd/Docker restart plus durable recovery owns continuation.

## Deployment hardening

System deployments should use non-login users, protected secret files, trusted TLS ingress and restricted health/metrics access. Docker release images run non-root, drop all capabilities, use `no-new-privileges`, a read-only root filesystem and a digest-pinned Node 24.19 base.

For Classic webhook mode, network controls are particularly important because the upstream GitLab version cannot provide timestamped HMAC replay protection.

## Supply chain

PR/release gates cover Node 22.22.2 and 24.19.0, unit/fuzz/governance tests, Docker build/smoke, backup/recovery, real GitLab CE 14.6.1/17.11.7/19.3.0 provider matrix, dependency audit, CodeQL, OCI vulnerability scanning, SBOM, checksums and provenance attestations.

Production should deploy verified release artifacts or the digest-pinned OCI image, never a mutable convenience tag as final identity.

## Reporting

Do not publish credentials, private source or exploitable details in public issues. Use GitHub private vulnerability reporting/security advisories when available.
