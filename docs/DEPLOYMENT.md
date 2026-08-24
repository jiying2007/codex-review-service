# Codex Review Service Deployment Guide

This guide describes the recommended production deployment for v4.0.4: **systemd + inline Runner + local SQLite**, followed by the optional isolated Runner topology.

## 1. Choose scope

One instance can manage explicit Projects, Groups, or both.

```json
"gitlab": {
  "baseUrl": "https://gitlab.example.internal",
  "projects": [101, 102],
  "groups": [{ "id": 20, "includeSubgroups": true }]
}
```

Use numeric GitLab Project/Group IDs. Group discovery is paginated and fail-closed.

## 2. Install runtime

Requirements:

- Linux with systemd
- Node.js 22.13+
- Git
- OpenAI Codex CLI
- GitLab Self-Managed 19.1+

Install the immutable release:

```bash
sudo useradd --system --create-home \
  --home-dir /home/codex-review \
  --shell /usr/sbin/nologin \
  codex-review

sudo mkdir -p /etc/codex-review

git clone --branch v4.0.4 --recurse-submodules \
  https://github.com/jiying2007/codex-review-service.git \
  /opt/codex-review-service

cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund
npm run core:init
```

For later releases, replace `v4.0.4` with the immutable release tag you intentionally selected and verify artifacts according to `VERIFY_RELEASE.md`.

## 3. Install non-secret configuration

```bash
sudo install -m 0644 \
  deploy/systemd/config.example.json \
  /etc/codex-review/config.json
```

Edit:

```bash
sudo editor /etc/codex-review/config.json
```

At minimum configure:

- `gitlab.baseUrl`;
- `gitlab.projects` and/or `gitlab.groups`;
- `webhook.expectedInstance` if different from the GitLab base URL;
- review concurrency/capacity only if defaults are not appropriate.

Keep `runner.mode="inline"` for the recommended first deployment.

## 4. Create credentials

Create a GitLab Project/Group access token with only the API access required for configured scope, MR/repository reads, discussions and commit-status publication.

Generate a Standard Webhooks Signing Token secret in the format expected by the service:

```bash
echo "whsec_$(openssl rand -base64 32)"
```

Install the secret environment file:

```bash
sudo install -o root -g codex-review -m 0640 \
  .env.example \
  /etc/codex-review-service.env

sudo editor /etc/codex-review-service.env
```

Set:

```text
GITLAB_API_TOKEN=...
GITLAB_WEBHOOK_SIGNING_TOKEN=whsec_...
```

Optionally set `OPENAI_API_KEY`. Otherwise authenticate Codex as the actual service user:

```bash
sudo -u codex-review -H codex login
sudo -u codex-review -H codex --version
```

Do not authenticate only as root; the systemd service runs as `codex-review`.

## 5. Install and validate systemd

```bash
sudo install -m 0644 \
  deploy/systemd/codex-review-service.service \
  /etc/systemd/system/codex-review-service.service

sudo systemctl daemon-reload
```

Run Doctor **before** starting:

```bash
cd /opt/codex-review-service
sudo -u codex-review \
  /usr/bin/node \
  --env-file=/etc/codex-review-service.env \
  src/doctor.js
```

Doctor validates config, state/database readiness, Codex capabilities, GitLab reachability and resolved Project/Group scope without executing reviewed repository code.

Only after Doctor succeeds:

```bash
sudo systemctl enable --now codex-review-service
systemctl status codex-review-service
journalctl -u codex-review-service -f
```

Validate:

```bash
curl -fsS http://127.0.0.1:8787/health/live
curl -fsS http://127.0.0.1:8787/health/ready
curl -fsS http://127.0.0.1:8787/metrics
```

Do not enable GitLab webhooks until `/health/ready` returns success.

## 6. Expose trusted HTTPS ingress

Keep the service bound to `127.0.0.1:8787` and terminate TLS at a trusted internal reverse proxy. Example Nginx skeleton:

```nginx
server {
    listen 443 ssl;
    server_name review.example.internal;

    ssl_certificate     /etc/nginx/ssl/review.crt;
    ssl_certificate_key /etc/nginx/ssl/review.key;

    location /webhooks/gitlab {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 2m;
    }

    location /health/ {
        allow 10.0.0.0/8;
        deny all;
        proxy_pass http://127.0.0.1:8787;
    }

    location /metrics {
        allow 10.0.0.0/8;
        deny all;
        proxy_pass http://127.0.0.1:8787;
    }
}
```

Restrict webhook ingress to GitLab/trusted networks where practical. Health/metrics should be reachable only by trusted monitoring systems.

## 7. Configure GitLab webhook

Configure the Project or Group webhook URL:

```text
https://review.example.internal/webhooks/gitlab
```

Enable:

- Merge request events
- Note events

Configure the same Standard Webhooks Signing Token represented by `GITLAB_WEBHOOK_SIGNING_TOKEN`.

GitLab 19.1+ Standard Webhooks signing semantics are required. Legacy plain `X-Gitlab-Token` compatibility is intentionally not provided.

## 8. First rollout validation

Use a test MR and verify:

1. signed webhook is accepted;
2. MR enters `running` status;
3. one durable review run appears in SQLite;
4. summary/discussions/status publish through the Outbox;
5. final status is terminal;
6. a new source push supersedes the old snapshot;
7. `/health/ready` remains healthy;
8. logs/metrics contain no repository content or credentials.

## 9. Repository policy

Optionally commit `.codex-safe.json` to reviewed target branches. The service reads the policy from immutable target `diff_refs.start_sha`, not from the MR source branch.

Repository policy can strengthen deterministic rules and lower resource ceilings; it cannot weaken service-wide security, confidence/blocking or capacity limits.

## 10. Hardened isolated Runner

Use this only when credential separation is required.

Create the Runner user while sharing the `codex-review` group:

```bash
sudo useradd --system --create-home \
  --home-dir /home/codex-review-runner \
  --shell /usr/sbin/nologin \
  --gid codex-review \
  codex-review-runner
```

Set in `/etc/codex-review/config.json`:

```json
"runner": {
  "mode": "isolated",
  "socket": "/run/codex-review-runner/runner.sock"
}
```

Install:

```bash
sudo install -o root -g codex-review -m 0640 \
  deploy/systemd/codex-review-runner.env.example \
  /etc/codex-review-runner.env

sudo install -m 0644 \
  deploy/systemd/codex-review-runner.service \
  /etc/systemd/system/codex-review-runner.service
```

Authenticate Codex as `codex-review-runner` or put only `OPENAI_API_KEY` in the Runner env file. Do not give the Runner GitLab credentials.

```bash
sudo -u codex-review-runner -H codex login
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-runner
sudo systemctl restart codex-review-service
```

Run Doctor/readiness again after the topology change.

## 11. Upgrade and rollback

Before upgrade, back up SQLite and record the current immutable tag.

```bash
cd /opt/codex-review-service
git fetch --tags origin
git checkout <new-release-tag>
git submodule update --init --recursive
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
```

Run Doctor, then restart the Runner (if isolated) and Controller, and require readiness success.

Rollback uses the same process with the previously recorded immutable tag. Back up SQLite before any version transition; see `OPERATIONS.md` for backup/restore procedures.
