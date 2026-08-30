# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

Production-grade, self-hosted Codex review enforcement for **GitLab Self-Managed merge requests**. The current product identity is defined by the machine-generated contract block below: one administrative/security trust domain can cover multiple explicit Projects and/or Groups, with durable GitLab publication and optional deterministic Feishu/Lark or WeCom attention routing.

## Product contract

<!-- BEGIN GENERATED PRODUCT CONTRACT -->

`product-contract.json` is the single machine-checked source for the current product identity:

- Service: **6.3.0**
- Database Schema: **6**
- Config Schema: **3**
- Policy Schema: **3**
- Review Receipt: **4**
- Safe Contract: **2**
- Safe Core: exact commit `10393a0035ce5168b3d0e88822af0d74fe85ec6c`
- Quality Platform: **3**
- Review Profile: **1**
- Profile Pack: **1**
- Impact Evidence: **2**
- Test Impact: **1**
- Analyzer Finding: **1**
- Analyzer Adapter: **1**
- Native/systemd Node.js: **22 LTS >=22.22.2, or 24 LTS >=24.19.0**; Node 23 is intentionally unsupported
- Canonical Docker runtime: **Node 24.19.0**
- GitLab Self-Managed compatibility floor: **14.6.1**
- GitLab recommendation: run a **vendor-supported GitLab release**; the compatibility floor is not a recommendation to stay on an old release

<!-- END GENERATED PRODUCT CONTRACT -->

GitLab compatibility is capability-driven rather than a pile of scattered version branches:

- **Classic profile** (`14.6.1` through `<15.7`): uses `GET .../merge_requests/:iid/changes` and proceeds only when GitLab explicitly returns `overflow: false`.
- **Modern profile** (`>=15.7`): uses paginated `/diffs` plus `/versions` and `real_size` to prove complete diff coverage.

If completeness cannot be proven in either profile, review is blocked before Codex is asked for a trusted verdict. Current real-provider CI covers GitLab CE **14.6.1**, **17.11.7**, and **19.3.0**. Safe Core remains Family v4; Service v6.3 does not change the shared review protocol.

## Start here

Use this product when you want server-side MR review that runs independently of developer workstations and publishes deterministic GitLab status, summary and discussions.

Recommended production deployment:

> **systemd + inline Runner + one local SQLite database**

Use the isolated Runner only when GitLab credentials and Codex/OpenAI credentials must be separated into different Unix users/processes. Docker/Compose is also first-class, but production should consume the **release-published digest-pinned `compose.release.yaml` / GHCR image**, not rebuild source on the target host.

## 5-minute deployment path

Install the verified `codex-review-service-6.3.0.tgz` release artifact under `/opt/codex-review-service`, or check out the exact release tag only for development/audit. Then:

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo install -d -o root -g codex-review -m 0750 /etc/codex-review/secrets
sudo install -m 0644 deploy/systemd/config.example.json /etc/codex-review/config.json
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/
```

Create each protected secret file as `root:codex-review` mode `0640`, and point the service at it with `*_FILE` variables. Value and `_FILE` forms are mutually exclusive.

```text
GITLAB_API_TOKEN_FILE=/etc/codex-review/secrets/gitlab-api-token
GITLAB_WEBHOOK_SIGNING_TOKEN_FILE=/etc/codex-review/secrets/gitlab-webhook-signing-token
OPENAI_API_KEY_FILE=/etc/codex-review/secrets/openai-api-key   # optional
```

For an OpenAI-compatible relay, do not rely on `~/.codex/config.toml`. Configure `codex.providerMode/providerBaseUrl/apiKeyEnv` explicitly and use the dedicated `CODEX_PROVIDER_API_KEY[_FILE]` secret. See [Codex Provider and Relay Configuration](docs/CODEX_PROVIDER.md).

Configure `schemaVersion: 3`, `gitlab.baseUrl`, `gitlab.projects` and/or `gitlab.groups`, then validate:

```bash
cd /opt/codex-review-service
sudo -u codex-review /usr/bin/node --env-file=/etc/codex-review-service.env src/doctor.js
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
curl -fsS http://127.0.0.1:8787/health/dependencies
curl -fsS http://127.0.0.1:8787/version
```

Doctor reports the detected GitLab version and `classic`/`modern` provider profile and performs a live probe of the configured Codex provider. Do not enable GitLab webhooks until Doctor and `/health/ready` pass.

## Docker / Compose

The release workflow publishes a canonical multi-architecture GHCR image, provenance, OCI SBOM/provenance metadata, `IMAGE_DIGEST.txt`, and a digest-pinned `compose.release.yaml`.

```bash
mkdir -p secrets
chmod 0700 secrets
printf '%s' "$GITLAB_API_TOKEN" > secrets/gitlab_api_token
printf '%s' "$GITLAB_WEBHOOK_SIGNING_TOKEN" > secrets/gitlab_webhook_signing_token
chmod 0600 secrets/*
docker compose -f compose.release.yaml up -d
curl -fsS http://127.0.0.1:8787/health/ready
```

The image runs non-root, drops Linux capabilities, uses a read-only root filesystem and persists only service state/Codex home. The Dockerfile pins the canonical Node 24.19.0 base by immutable multi-platform digest and strips npm/npx/yarn/corepack from the final runtime after build-time installation. Host Node is irrelevant when deploying the official container.

## Connect GitLab

Expose the service through trusted HTTPS ingress/reverse proxy and configure:

```text
POST https://<review-host>/webhooks/gitlab
```

Enable **Merge request events** and **Note events**. Use the same Standard Webhooks Signing Token represented by `GITLAB_WEBHOOK_SIGNING_TOKEN` or its `_FILE` form.

GitLab 14.6.1 is a compatibility floor, not a recommendation to remain on an unsupported server release. Upgrade GitLab as an independent infrastructure/security project when practical; Codex Review Service does not require that upgrade before it can be deployed.

## Durable architecture

```text
developer opens/updates GitLab MR
          ↓
GitLab signed webhook
          ↓
SQLite durable review queue
          ↓
immutable start_sha + head_sha evidence
          ↓
GitLab capability profile proves complete diff
          ↓
Codex Safe Review
          ↓
SQLite Review Receipt
          ├─ GitLab Publication Outbox
          │    ├─ status
          │    ├─ summary
          │    └─ discussions
          └─ Notification Outbox
               ├─ Feishu/Lark
               └─ WeCom
```

GitLab remains the Review system of record. SQLite is service durable state. IM is an attention channel only and never participates in verdict or approval.

## Multi-repository scope and trust boundary

One instance can manage explicit Projects, a Group hierarchy, or both. Group discovery is paginated and fail-closed; incomplete refresh keeps the last complete scope.

```json
"projects": [101, 102, 103],
"groups": [{ "id": 20, "includeSubgroups": true }]
```

**One Service instance is one administrative/security trust domain.** Projects in materially different credential, confidentiality or OpenAI data-policy domains should use separate instances rather than introducing hidden multi-tenant behavior.

## IM notifications

Optional Feishu/Lark and WeCom routes use a **separate durable `notification_outbox`** with deterministic cards, idempotency, bounded retry, restart recovery and terminal failure. Notification failure never changes a review verdict and never reruns Codex.

See [IM Notifications](docs/NOTIFICATIONS.md).

## Health, SLO primitives and operations

```text
GET /health/live           process alive
GET /health/ready          safe to accept/persist webhook traffic
GET /health/dependencies   GitLab/scope dependency health
GET /version               product/runtime identity
GET /metrics               Prometheus metrics
```

`/health/ready` deliberately does **not** become unavailable merely because GitLab is temporarily degraded when durable intake is still safe. Dependency degradation is visible separately.

Metrics include queue depth, oldest queue/outbox age, token usage, workers and low-cardinality product identity. Operators can use the built-in control plane:

```bash
npm run admin -- status
npm run admin -- jobs
npm run admin -- publications
npm run admin -- notifications
npm run admin -- retry-publication <id>
npm run admin -- retry-notification <id>
npm run admin -- drain 60
npm run admin -- reconcile
npm run admin -- db-check
npm run admin -- backup /secure-backup/review.sqlite
npm run admin -- backup-verify /secure-backup/review.sqlite
npm run admin -- diagnostics
```

Backups use the SQLite online backup API available on both supported Node lines and are rejected unless `quick_check`, foreign-key validation and Schema 6 verification pass.

## Failure semantics

Review, GitLab publication and IM notification are independent durable failure domains. A publication/notification retry never reruns a persisted Codex review. Unexpected `unhandledRejection` or `uncaughtException` is treated as fatal: the service drains its owned resources, checkpoints durable state, exits non-zero and relies on systemd/Docker restart plus recovery semantics.

## Configuration ownership

```text
/etc/codex-review/config.json      non-secret Config Schema 3
/etc/codex-review/secrets/*        protected secret files
/var/lib/codex-review              SQLite/state
```

Direct user mode uses XDG config/state defaults. There is one closed JSON configuration schema and no root/sudo/systemd runtime detection.

## Upgrade contract

Schema 5 is the first supported production database. **v5.0.0 is the line after which released persistence/config compatibility becomes a product contract.** Future DB or Config Schema changes must ship explicit migration fixtures, forward-upgrade tests and a documented rollback boundary; pre-release hard-cut behavior must not be reused as a normal upgrade mechanism.

## Verification and governance

PR/release gates include Node 22.22.2 and 24.19.0 tests, Docker build/smoke, recovery/backup tests, dependency audit, CodeQL, real GitLab CE 14.6.1/17.11.7/19.3.0 provider matrix, package boundary, OCI vulnerability scan, SBOM, checksum and GitHub provenance attestations.

- Deployment: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- Codex provider / relay: [docs/CODEX_PROVIDER.md](docs/CODEX_PROVIDER.md)
- GitLab setup: [docs/GITLAB_SETUP.md](docs/GITLAB_SETUP.md)
- IM notifications: [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)
- Docker: [deploy/docker/README.md](deploy/docker/README.md)
- Operations/upgrade/DR: [OPERATIONS.md](OPERATIONS.md)
- Support: [SUPPORT.md](SUPPORT.md)
- Security: [SECURITY.md](SECURITY.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Release verification: [VERIFY_RELEASE.md](VERIFY_RELEASE.md)

## License

MIT
