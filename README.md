# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

Persistent, self-hosted Codex code review service for GitLab Self-Managed merge requests.

## What it does

- Receives GitLab Merge Request and Note webhooks.
- Automatically reviews MR open / update / reopen events.
- Supports manual re-review with `/codex review`.
- Persists webhook deliveries, jobs, runs, and findings in SQLite WAL.
- Deduplicates webhook retries and repeated reviews of the same MR HEAD.
- Cancels/supersedes stale reviews when a new HEAD arrives.
- Uses GitLab's merge request diffs API rather than the deprecated `/changes` endpoint.
- Validates findings against changed files and changed post-change lines.
- Upserts one MR summary note and creates inline diff discussions.
- Resolves obsolete prior discussions when a finding disappears.
- Publishes an external commit status named `codex-review`.
- Treats incomplete diff coverage as a failed gate instead of a false pass.
- Runs Codex in an empty temporary directory with a read-only sandbox and a filtered environment that does not contain GitLab credentials.

## Architecture

```text
GitLab Self-Managed
      │
      │ Merge Request / Note webhook
      ▼
Codex Review Service
      │
      ├─ webhook authentication + replay window
      ├─ event router
      ├─ SQLite persistent queue + idempotency
      ├─ stale review cancellation
      ├─ GitLab MR snapshot / diff adapter
      ├─ Codex structured review
      ├─ deterministic finding validation / policy
      └─ GitLab publisher
             ├─ summary note
             ├─ inline discussions
             └─ external commit status
```

## Requirements

- Node.js 22.13+
- OpenAI Codex CLI available to the service account
- GitLab Self-Managed reachable from the service host
- A GitLab project/group access token with API permissions needed to read MRs/diffs and write notes, discussions, and commit statuses
- GitLab webhook signing token (recommended on GitLab 19+) or legacy secret token

## Install

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo mkdir -p /opt/codex-review-service /var/lib/codex-review
sudo chown -R codex-review:codex-review /var/lib/codex-review

git clone https://github.com/jiying2007/codex-review-service.git /opt/codex-review-service
cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund
```

Authenticate Codex as the service user, or provide `OPENAI_API_KEY` through the protected environment file.

```bash
sudo -u codex-review -H codex login
```

Copy `.env.example` to `/etc/codex-review-service.env`, set permissions to `0600`, and fill in the GitLab/Codex values.

```bash
sudo install -m 0600 .env.example /etc/codex-review-service.env
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/codex-review-service.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
```

## GitLab webhook

Create a project or group webhook pointing to:

```text
https://review.example.internal/webhooks/gitlab
```

Enable:

- Merge request events
- Note events

For GitLab 19+, generate a **Signing token** and set the same `whsec_...` value in `GITLAB_WEBHOOK_SIGNING_TOKEN`. During migration or on older GitLab, set `GITLAB_WEBHOOK_SECRET_TOKEN` and configure the webhook secret token.

## Merge gate

The service writes an external commit status:

- `running` while Codex is reviewing
- `success` for `pass` and `needs_attention`
- `failed` for `block`, `incomplete`, or service failure

`critical` and `high` findings are blocking. `medium`, `low`, and `info` findings are advisory. Diff coverage that is truncated, collapsed, too large, or skipped because of the configured byte budget is **never** treated as pass.

To use it as a merge gate, configure GitLab so pipelines must succeed before merge.

## Security model

The GitLab API token belongs only to the service controller. Codex receives a filtered environment containing only basic runtime variables, `CODEX_HOME`, and optionally `OPENAI_API_KEY`; GitLab API/webhook credentials are intentionally excluded.

Repository-derived data is treated as untrusted. Codex receives only the MR title/description and bounded textual diffs. It runs in a fresh temporary directory with `--sandbox read-only` and `--skip-git-repo-check`, so it does not need a repository checkout.

See [SECURITY.md](SECURITY.md).

## Health and metrics

```text
GET /health/live
GET /health/ready
GET /metrics
```

`/health/ready` checks GitLab reachability and worker state. `/metrics` currently exposes queue depth in Prometheus text format.

## Configuration

See [.env.example](.env.example). Important controls include:

- `MAX_DIFF_BYTES`
- `MAX_FINDINGS`
- `MIN_CONFIDENCE`
- `REVIEW_TIMEOUT_SECONDS`
- `AUTO_RESOLVE_OBSOLETE`
- `TRIGGER_ON_OPEN`
- `TRIGGER_ON_PUSH`
- `TRIGGER_ON_REOPEN`

## Development

```bash
npm ci
npm run ci
```

CI runs on Node.js 22 and 24.

## Status

Initial service architecture. GitLab is the first remote SCM provider; the review core and publisher boundaries are intentionally kept separate so additional providers can be added later without coupling Codex execution to GitLab credentials.
