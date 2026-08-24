# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

Production-grade, self-hosted Codex review enforcement for **GitLab Self-Managed merge requests**. One service instance can manage multiple Projects and/or Groups and can optionally route deterministic review cards to Feishu/Lark or WeCom.

## Start here

Use this product when you want server-side MR review that runs independently of developer workstations and publishes deterministic GitLab status/discussions.

Recommended production deployment:

> **systemd + inline Runner + one local SQLite database**

For fast container rollout, a hardened rootless Docker/Compose deployment is also first-class. Use isolated Runner mode only when GitLab credentials and Codex/OpenAI credentials must be separated into different Unix users/processes.

Requirements:

- Node.js 22.13+
- GitLab Self-Managed 19.1+
- GitLab Standard Webhooks Signing Token
- a scoped GitLab API token
- OpenAI Codex CLI authenticated as the execution user, or `OPENAI_API_KEY`

Full production instructions: [Deployment Guide](docs/DEPLOYMENT.md). GitLab UI setup: [GitLab Setup](docs/GITLAB_SETUP.md).

## 5-minute systemd deployment

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo mkdir -p /etc/codex-review

git clone --branch v4.1.0 --recurse-submodules \
  https://github.com/jiying2007/codex-review-service.git \
  /opt/codex-review-service
cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund
npm run core:init

sudo install -m 0644 deploy/systemd/config.example.json /etc/codex-review/config.json
sudo install -o root -g codex-review -m 0640 .env.example /etc/codex-review-service.env
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/
```

Configure `gitlab.baseUrl`, `gitlab.projects` and/or `gitlab.groups`, `GITLAB_API_TOKEN`, and `GITLAB_WEBHOOK_SIGNING_TOKEN`. Then authenticate Codex and validate:

```bash
sudo -u codex-review -H codex login
sudo -u codex-review /usr/bin/node --env-file=/etc/codex-review-service.env src/doctor.js
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
```

Do not enable GitLab webhooks until Doctor and readiness pass.

## Docker / Compose

A rootless container deployment is available under `deploy/docker/`:

```bash
cp config.example.json deploy/docker/config.json
cp .env.example deploy/docker/.env
# Set server.host=0.0.0.0 and server.dataDir=/var/lib/codex-review in deploy/docker/config.json.
docker compose -f deploy/docker/compose.yaml up -d --build
curl -fsS http://127.0.0.1:8787/health/ready
```

The image runs non-root, drops Linux capabilities, uses a read-only root filesystem, persists only service state/Codex home, and pins the default Codex CLI image dependency while retaining the runtime Safe Contract capability probe. See [Docker deployment](deploy/docker/README.md).

## Connect GitLab

Expose the service through trusted HTTPS ingress/reverse proxy and configure GitLab 19.1+ webhook:

```text
https://<review-host>/webhooks/gitlab
```

Enable **Merge request events** and **Note events**, and use the same Standard Webhooks Signing Token represented by `GITLAB_WEBHOOK_SIGNING_TOKEN`.

## Multi-repository scope

One instance can manage explicit Projects, a Group hierarchy, or both. Group discovery is paginated and fail-closed; incomplete discovery never replaces the last complete scope.

```json
"projects": [101, 102, 103],
"groups": [{ "id": 20, "includeSubgroups": true }]
```

## IM notifications

Optional Feishu/Lark and WeCom routes use a **separate durable notification outbox** with deterministic cards, idempotency, bounded retry, restart recovery, terminal failed state, and Prometheus metrics.

```json
"notifications": {
  "enabled": true,
  "events": ["review.blocked", "review.failed", "service.degraded"],
  "routes": [
    {
      "name": "embedded-review",
      "provider": "feishu",
      "secretRef": "embedded",
      "projects": [101, 102],
      "groups": [],
      "events": ["review.blocked", "review.failed"]
    }
  ]
}
```

`secretRef: "embedded"` resolves only from `CODEX_REVIEW_NOTIFY_EMBEDDED_WEBHOOK`. Webhook secrets are never stored in JSON or SQLite. Notification failure **never changes the Review verdict and never reruns Codex**. Add `review.completed` explicitly only for audit channels to avoid chat noise. See [IM Notifications](docs/NOTIFICATIONS.md).

## How developers use it

```text
developer opens/updates GitLab MR
          ↓
GitLab signed webhook
          ↓
Codex Review Service queue
          ↓
immutable MR evidence + target .codex-safe.json
          ↓
deterministic rules + Codex review
          ↓
SQLite Review Receipt + GitLab Publication Outbox + Notification Outbox
          ├─ GitLab status / summary / discussions
          └─ optional Feishu / WeCom deterministic card
```

No per-developer extension is required for server review. GitLab remains the Review system of record; SQLite remains the Service durable source of truth; IM is an attention channel only.

## Configuration ownership

System deployment:

```text
/etc/codex-review/config.json      non-secret product configuration
/etc/codex-review-service.env      secrets only
/var/lib/codex-review              SQLite/state
```

Direct user mode instead uses XDG config/state defaults. There is one closed JSON configuration schema and no root/sudo/systemd runtime detection.

Supported secret/process inputs are:

```text
CODEX_REVIEW_CONFIG_FILE
GITLAB_API_TOKEN
GITLAB_WEBHOOK_SIGNING_TOKEN
OPENAI_API_KEY
CODEX_REVIEW_NOTIFY_<SECRET_REF>_WEBHOOK   # only for configured IM routes
```

## Repository policy

Reviewed repositories may commit target-branch `.codex-safe.json` Policy Schema v3. Repository policy may narrow limits or strengthen rules, but cannot weaken service-wide security, blocking/confidence or capacity boundaries.

## Operations

```text
GET /health/live
GET /health/ready
GET /metrics
```

Use `npm run doctor` before initial rollout and after meaningful configuration/auth changes.

- Full deployment: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- GitLab setup: [docs/GITLAB_SETUP.md](docs/GITLAB_SETUP.md)
- IM notifications: [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)
- Docker: [deploy/docker/README.md](deploy/docker/README.md)
- Operations/upgrade/backup/incidents: [OPERATIONS.md](OPERATIONS.md)
- Support checklist: [SUPPORT.md](SUPPORT.md)
- Security: [SECURITY.md](SECURITY.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Release verification: [VERIFY_RELEASE.md](VERIFY_RELEASE.md)

## Hardened isolated Runner

For credential separation set `runner.mode="isolated"` and deploy `codex-review-runner.service` as the separate `codex-review-runner` user. Inline remains the recommended default unless this isolation is required.

## Development

```bash
git submodule update --init --recursive
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm pack --dry-run --ignore-scripts
```

## License

MIT
