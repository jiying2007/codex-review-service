# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

Production-grade, self-hosted Codex review service for GitLab Self-Managed merge requests. **v2.0 removes all v1 compatibility paths** and makes the operating model explicit: one canonical non-secret config file, signed GitLab webhooks, explicit Projects/Groups scope, durable SQLite/Outbox semantics, and optional isolated Codex Runner hardening.

## Requirements

- Node.js **22.13+**
- GitLab Self-Managed **19.1+** with a Standard Webhooks Signing Token
- GitLab API token with only the project/group/MR/repository/discussion/status permissions required by the configured scope
- OpenAI Codex CLI authenticated as the service user, or as the isolated Runner user in Hardened mode

## Configuration contract

All non-secret product settings live in one file:

```text
/etc/codex-review/config.json
```

Copy [`config.example.json`](config.example.json) and edit it. The only supported environment inputs are:

```text
CODEX_REVIEW_CONFIG_FILE   # optional alternate config path
GITLAB_API_TOKEN           # required secret
GITLAB_WEBHOOK_SIGNING_TOKEN # required secret
OPENAI_API_KEY             # optional Codex auth secret
```

There is no environment override for project scope, runner mode, concurrency, limits, lifecycle, observability, GitLab URL, or review policy ceilings. This prevents hidden configuration precedence.

## Standard Deployment

The default production path is one process with inline Codex:

```text
GitLab → codex-review-service
            ├─ SQLite WAL + synchronous=FULL
            ├─ Review Workers
            ├─ Publication Outbox / Publisher Workers
            └─ Codex CLI (inline)
```

Minimal install:

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo mkdir -p /etc/codex-review

git clone https://github.com/jiying2007/codex-review-service.git /opt/codex-review-service
cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund

sudo install -m 0644 config.example.json /etc/codex-review/config.json
sudo install -o root -g codex-review -m 0640 .env.example /etc/codex-review-service.env
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/

sudo -u codex-review -H codex login
sudo -u codex-review /usr/bin/node --env-file=/etc/codex-review-service.env src/doctor.js
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
```

Edit `config.json` and the environment file before Doctor/startup.

## Multi-repository scope

One service instance monitors many repositories through explicit Projects and/or Groups:

```json
{
  "gitlab": {
    "baseUrl": "https://gitlab.example.internal",
    "projects": [101, 102, 103],
    "groups": [
      { "id": 20, "includeSubgroups": true },
      { "id": 35, "includeSubgroups": false }
    ]
  },
  "review": {
    "concurrency": 4
  },
  "runner": {
    "mode": "inline"
  }
}
```

Group Projects discovery is paginated, deduplicated, excludes archived projects, and only accepts a newly discovered scope after complete discovery. Failed/incomplete refresh keeps the last complete scope and makes readiness unhealthy. Different MRs can run concurrently; the same MR is always serialized.

## Hardened Deployment

For a stronger credential/process boundary:

```json
{
  "runner": {
    "mode": "isolated",
    "socket": "/run/codex-review-runner/runner.sock"
  }
}
```

Run `codex-review-runner.service` under the separate Runner user. Both Controller and Runner read the same `config.json`. The Controller owns GitLab credentials and SQLite; the Runner owns Codex/OpenAI credentials and no GitLab credentials.

## Webhook

Configure a GitLab 19.1+ Signing Token and enable **Merge request events** and **Note events** for:

```text
https://review.example.internal/webhooks/gitlab
```

The receiver requires `webhook-id`, `webhook-timestamp`, `webhook-signature`, validates the HMAC over the exact raw body, enforces replay skew, validates `X-Gitlab-Instance`, deduplicates delivery IDs, and returns quickly after durable local enqueue. Plain-text `X-Gitlab-Token` authentication is not supported in v2.

## Reliability and security invariants

- webhook ACK is backed by SQLite `WAL + synchronous=FULL`;
- Review execution and GitLab publication are separate durable failure domains through a transactional Outbox;
- review identity binds target `start_sha` + source `head_sha`;
- stale results and publications cannot write to a changed/removed scope;
- GitLab status targets the source project/ref and exact `pipeline_id` when resolvable;
- exact changed-line finding validation; no silent line relocation;
- stable code-anchor finding identity;
- provider/local coverage gaps fail closed;
- immutable bounded context is fetched at exact SHAs without cloning/executing reviewed code;
- deterministic target-policy analyzers share the same Gate/Outbox lifecycle as AI findings;
- token usage and MR/project budgets are persisted/enforced;
- GitLab API traffic is rate-limited and protected by Retry-After/circuit-breaker logic;
- GitHub Actions dependencies are manually reviewed and pinned to immutable full SHAs.

## Repository review policy

Repositories may commit `.codex-review.json` on the target branch. The service reads it only from `diff_refs.start_sha`. See [`.codex-review.example.json`](.codex-review.example.json). Repository policy may narrow ceilings/add deterministic checks but cannot weaken global gate, confidence, credential, execution, or service-capacity boundaries.

## Health and operations

```text
GET /health/live
GET /health/ready
GET /metrics
```

`npm run doctor` validates config, SQLite durability/schema, Codex/Runner capability, GitLab reachability, and complete Projects/Groups resolution without reviewing repository code.

See [OPERATIONS.md](OPERATIONS.md), [SECURITY.md](SECURITY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [LONG_TERM_ASSET.md](LONG_TERM_ASSET.md), and [CHANGELOG.md](CHANGELOG.md).

## v1.x → v2.0 migration

Move all non-secret environment settings into `/etc/codex-review/config.json`. Remove `GITLAB_PROJECT_ALLOWLIST`, `GITLAB_WEBHOOK_SECRET_TOKEN`, `CODEX_RUNNER_MODE`, `CODEX_RUNNER_SOCKET`, `GITLAB_BASE_URL`, tuning/budget/lifecycle env overrides, and OTLP env overrides. Configure a GitLab Signing Token and set only the supported secrets in the environment file. Run Doctor before re-enabling webhooks.

## Development

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm pack --dry-run --ignore-scripts
```

CI validates Node.js 22.13.0 and Node.js 24.
