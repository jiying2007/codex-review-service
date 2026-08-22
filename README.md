# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

Production-grade, self-hosted Codex review service for GitLab Self-Managed merge requests. v1.2 keeps the v1.1 reliability/security core, but makes deployment and multi-repository scope much simpler.

## Standard Deployment

The default deployment is intentionally simple: **one service process, one structured config file, and GitLab secrets in a protected environment file**. Codex runs inline under the service account.

```text
GitLab → codex-review-service
            ├─ SQLite WAL + synchronous=FULL
            ├─ Review Workers
            ├─ Publication Outbox / Publisher Workers
            └─ Codex CLI (inline)
```

Create `/etc/codex-review/config.json` from `config.example.json`:

```json
{
  "gitlab": {
    "baseUrl": "https://gitlab.example.internal",
    "projects": [101, 102],
    "groups": [
      { "id": 20, "includeSubgroups": true }
    ]
  },
  "review": { "concurrency": 2 },
  "runner": { "mode": "inline" }
}
```

`gitlab.projects` and discovered group projects are merged and deduplicated. GitLab's paginated Group Projects API is used for group expansion; archived projects are excluded and only projects with Merge Requests enabled are included. Group discovery is fail-closed: an incomplete/failed refresh does not replace the last complete scope and readiness becomes unhealthy.

Keep secrets in `/etc/codex-review-service.env`:

```text
GITLAB_API_TOKEN=...
GITLAB_WEBHOOK_SIGNING_TOKEN=whsec_...
```

Then install and start:

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo mkdir -p /etc/codex-review /opt/codex-review-service

git clone https://github.com/jiying2007/codex-review-service.git /opt/codex-review-service
cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund

sudo install -m 0644 config.example.json /etc/codex-review/config.json
sudo install -m 0600 .env.example /etc/codex-review-service.env
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/

sudo -u codex-review -H codex login
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
npm run doctor
curl -fsS http://127.0.0.1:8787/health/ready
```

Edit the two files before starting production. `/etc/codex-review/config.json` contains non-secret product settings; the environment file should contain credentials and only exceptional overrides.

## Multi-repository scope

One Review Service instance can monitor and process many repositories concurrently.

```json
{
  "gitlab": {
    "projects": [101, 102, 103],
    "groups": [
      { "id": 20, "includeSubgroups": true },
      { "id": 35, "includeSubgroups": false }
    ]
  }
}
```

Different MRs can run in parallel up to `review.concurrency`; the same MR remains strictly serialized. Explicit project IDs plus group-discovered project IDs form one runtime allowlist used by webhook acceptance and periodic reconciliation.

`GITLAB_PROJECT_ALLOWLIST` remains supported for existing deployments. When it is set, it intentionally overrides `gitlab.projects` and `gitlab.groups`. `GITLAB_PROJECT_ALLOWLIST=*` remains webhook-only and disables exhaustive reconciliation.

## Hardened Deployment

For higher-security environments, set:

```json
{
  "runner": {
    "mode": "isolated",
    "socket": "/run/codex-review-runner/runner.sock"
  }
}
```

Then run the optional `codex-review-runner.service` under a separate Unix user. The Controller owns GitLab credentials and SQLite; the Runner owns Codex/OpenAI credentials and communicates only over the local Unix socket. This is a defense-in-depth mode, not a prerequisite for normal production use.

## Reliability and review guarantees

- Webhook ACK is backed by SQLite `WAL + synchronous=FULL`.
- Review execution and GitLab publication are separate failure domains through a transactional persistent Outbox.
- Reviews bind to target `start_sha` + source `head_sha`; stale results cannot publish.
- External status targets the correct source project/ref and exact `pipeline_id` when available.
- Same MR serialized; different MRs can run concurrently.
- GitLab requests are rate-limited and protected by a transient-failure circuit breaker.
- Findings must map to exact changed lines; no silent line-number relocation.
- Finding identity uses stable code anchors.
- Provider/local coverage gaps fail closed; metadata-only/generated/known binary changes are classified separately.
- Controller context is bounded and read from immutable target/source SHAs; reviewed code is never cloned or executed.
- Target-branch deterministic rules and Codex findings share one Gate/Outbox lifecycle.
- Codex token usage and optional MR/project budgets are persisted and enforced.
- GitHub Actions dependencies are pinned to immutable commit SHAs.

## GitLab webhook

Use:

```text
https://review.example.internal/webhooks/gitlab
```

Enable **Merge request events** and **Note events**. GitLab 19+ Standard Webhooks Signing Token is recommended. `/codex review` manual re-review requires Developer access by default.

## Repository review policy

A repository can commit `.codex-review.json` on its target branch. The service reads it at `diff_refs.start_sha`, never from the unreviewed source branch. See `.codex-review.example.json`.

Repository policy may narrow resource ceilings and add deterministic rules, but cannot weaken the global blocking threshold, confidence floor, credentials, Safe Contract, or service concurrency.

## Health and operations

```text
GET /health/live
GET /health/ready
GET /metrics
```

Readiness includes GitLab, SQLite durability, workers, publishers, circuit state and project-scope discovery health. `npm run doctor` also resolves configured groups and reports the final project count before production rollout.

See [OPERATIONS.md](OPERATIONS.md), [SECURITY.md](SECURITY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [LONG_TERM_ASSET.md](LONG_TERM_ASSET.md), and [CHANGELOG.md](CHANGELOG.md).

## Development

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm pack --dry-run --ignore-scripts
```

CI validates Node.js 22.13.0 and Node.js 24.
