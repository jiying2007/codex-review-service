# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

Production-grade, self-hosted Codex review enforcement for **GitLab Self-Managed merge requests**. One service instance can manage multiple Projects and/or Groups.

## Start here

Use this product when you want server-side MR review that runs independently of developer workstations and publishes deterministic GitLab status/discussions.

Recommended first deployment:

> **systemd + inline Runner + one local SQLite database**

Use isolated Runner mode only when GitLab credentials and Codex/OpenAI credentials must be separated into different Unix users/processes.

Requirements:

- Node.js 22.13+
- GitLab Self-Managed 19.1+
- GitLab Standard Webhooks Signing Token
- a scoped GitLab API token
- OpenAI Codex CLI authenticated as the execution user, or `OPENAI_API_KEY`

Full production instructions: [Deployment Guide](docs/DEPLOYMENT.md).

## 5-minute deployment path

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo mkdir -p /etc/codex-review

git clone --branch v4.0.4 --recurse-submodules \
  https://github.com/jiying2007/codex-review-service.git \
  /opt/codex-review-service
cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund
npm run core:init

sudo install -m 0644 deploy/systemd/config.example.json /etc/codex-review/config.json
sudo install -o root -g codex-review -m 0640 .env.example /etc/codex-review-service.env
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/
```

Then configure exactly these first:

1. `gitlab.baseUrl`;
2. `gitlab.projects` and/or `gitlab.groups`;
3. `GITLAB_API_TOKEN`;
4. `GITLAB_WEBHOOK_SIGNING_TOKEN`.

Authenticate Codex and validate before startup:

```bash
sudo -u codex-review -H codex login
sudo -u codex-review /usr/bin/node \
  --env-file=/etc/codex-review-service.env \
  src/doctor.js

sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
```

Do not enable GitLab webhooks until Doctor and readiness pass.

## Connect GitLab

Expose the service through trusted HTTPS ingress/reverse proxy and configure GitLab 19.1+ webhook:

```text
https://<review-host>/webhooks/gitlab
```

Enable:

- Merge request events
- Note events

Use the same Standard Webhooks Signing Token represented by `GITLAB_WEBHOOK_SIGNING_TOKEN`.

## Multi-repository scope

One instance can manage explicit Projects:

```json
"projects": [101, 102, 103],
"groups": []
```

or an entire Group hierarchy:

```json
"projects": [],
"groups": [{ "id": 20, "includeSubgroups": true }]
```

or both. Group discovery is paginated and fail-closed; incomplete discovery never replaces the last complete scope.

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
SQLite Review Receipt + Publication Outbox
          ↓
GitLab status / summary / discussions
```

No per-developer extension is required for server review.

## Configuration ownership

System deployment:

```text
/etc/codex-review/config.json      non-secret product configuration
/etc/codex-review-service.env      secrets only
/var/lib/codex-review              SQLite/state
```

Direct user mode instead uses XDG config/state defaults. There is one JSON schema and no root/sudo/systemd runtime detection.

Only these process inputs are supported:

```text
CODEX_REVIEW_CONFIG_FILE
GITLAB_API_TOKEN
GITLAB_WEBHOOK_SIGNING_TOKEN
OPENAI_API_KEY
```

## Repository policy

Reviewed repositories may commit target-branch `.codex-safe.json` Policy Schema v3. Repository policy may narrow limits or strengthen rules, but cannot weaken service-wide security, blocking/confidence or capacity boundaries.

## Operations

Health endpoints:

```text
GET /health/live
GET /health/ready
GET /metrics
```

Use `npm run doctor` before initial rollout and after meaningful configuration/auth changes.

- Full deployment: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- Operations/upgrade/backup/incidents: [OPERATIONS.md](OPERATIONS.md)
- Support checklist: [SUPPORT.md](SUPPORT.md)
- Security: [SECURITY.md](SECURITY.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Release verification: [VERIFY_RELEASE.md](VERIFY_RELEASE.md)

## Hardened isolated Runner

For credential separation set:

```json
"runner": {
  "mode": "isolated",
  "socket": "/run/codex-review-runner/runner.sock"
}
```

and deploy `codex-review-runner.service` as the separate `codex-review-runner` user. See the Deployment Guide; inline is the recommended default unless this isolation is required.

## Development

```bash
git submodule update --init --recursive
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm pack --dry-run --ignore-scripts
```

## License

MIT
