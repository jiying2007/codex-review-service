# Production Deployment

## Supported baseline

Read `product-contract.json` before deployment. Codex Review Service 5.0.1 requires Node.js >=24.19.0 <25, GitLab Self-Managed >=19.1.0, Database Schema 5 and Config Schema 1.

Safe Core remains exact commit-pinned. Do not replace the gitlink or copy a different Core runtime into a release package.

## Choose a deployment mode

### Standard systemd / inline Runner

Recommended default. Controller, SQLite, GitLab provider and Codex execution run as one Unix service user.

### Hardened systemd / isolated Runner

Use when GitLab credentials and OpenAI/Codex credentials must live in different Unix users/processes. Controller owns GitLab/state. Runner owns Codex/OpenAI credentials and exposes only the Unix-socket Safe Contract.

### Docker / Compose

Use the release-published `compose.release.yaml` and canonical GHCR digest. Do not rebuild source on production hosts.

## Install the verified release

Verify release checksums and provenance first; see `VERIFY_RELEASE.md`. Extract the verified tgz into `/opt/codex-review-service` or use the digest-pinned OCI image.

For systemd:

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo install -d -o root -g codex-review -m 0750 /etc/codex-review/secrets
sudo install -d -o codex-review -g codex-review -m 0700 /var/lib/codex-review
sudo install -m 0644 deploy/systemd/config.example.json /etc/codex-review/config.json
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/
```

Create each secret file as `root:codex-review` mode `0640`. For isolated mode, give the Runner-owned OpenAI secret to the Runner group/user instead of the Controller group. Also install `codex-review-runner.service` and its environment example.

## Configure Config Schema 1

The file must explicitly contain:

```json
{
  "schemaVersion": 1,
  "server": { "host": "127.0.0.1", "port": 8787, "dataDir": "/var/lib/codex-review" },
  "gitlab": {
    "baseUrl": "https://gitlab.example.internal",
    "projects": [101, 102],
    "groups": [{ "id": 20, "includeSubgroups": true }]
  }
}
```

At least one Project or Group is required. Unknown keys and unsupported Config Schema versions fail closed.

## Provision secrets

Production should use protected files and `_FILE` inputs:

```text
GITLAB_API_TOKEN_FILE=/etc/codex-review/secrets/gitlab-api-token
GITLAB_WEBHOOK_SIGNING_TOKEN_FILE=/etc/codex-review/secrets/gitlab-webhook-signing-token
OPENAI_API_KEY_FILE=/etc/codex-review/secrets/openai-api-key       # optional, inline mode
```

`GITLAB_API_TOKEN` / `GITLAB_WEBHOOK_SIGNING_TOKEN` direct values remain supported where appropriate, but a value and matching `_FILE` cannot both be set.

The GitLab API token should be scoped to the configured Projects/Groups and only have permissions needed for MR reads, repository reads, notes/discussions and commit statuses. Rotate credentials through protected files, Doctor and service restart.

## Authenticate Codex

Either authenticate as the execution user:

```bash
sudo -u codex-review -H codex login
```

or provide `OPENAI_API_KEY_FILE`. In isolated mode, this credential belongs only to the Runner process.

## Doctor preflight

```bash
cd /opt/codex-review-service
sudo -u codex-review /usr/bin/node \
  --env-file=/etc/codex-review-service.env \
  src/doctor.js
```

Doctor validates product/config identity, SQLite Schema 5/integrity, Codex capability contract, GitLab connectivity/version and complete Project/Group scope.

## Start systemd

Standard:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
```

Isolated:

```bash
sudo systemctl enable --now codex-review-runner
sudo systemctl enable --now codex-review-service
```

Validate:

```bash
curl -fsS http://127.0.0.1:8787/health/live
curl -fsS http://127.0.0.1:8787/health/ready
curl -fsS http://127.0.0.1:8787/health/dependencies
curl -fsS http://127.0.0.1:8787/version
curl -fsS http://127.0.0.1:8787/metrics | head
```

`/health/ready` means safe durable webhook intake. `/health/dependencies` reports GitLab/scope degradation separately.

## Configure GitLab webhook

Expose trusted HTTPS ingress to:

```text
https://<review-host>/webhooks/gitlab
```

Create a GitLab webhook using a Standard Webhooks Signing Token and enable:

- **Merge request events**
- **Note events**

The Signing Token must match `GITLAB_WEBHOOK_SIGNING_TOKEN` / `_FILE`. Do not enable the webhook until Doctor and `/health/ready` pass.

## End-to-end acceptance

For a disposable test MR:

1. Open or update the MR.
2. Confirm webhook returns quickly and one durable job is queued.
3. Observe `running`, then terminal GitLab status.
4. Confirm exactly one durable Review Run for the immutable snapshot.
5. Confirm summary/discussions publish through `publication_outbox`.
6. If notifications are enabled, confirm the deterministic Feishu/WeCom card is delivered through `notification_outbox`.
7. Push a new commit and confirm older snapshot work is superseded/stale publication is prevented.
8. Send a duplicate webhook and confirm idempotent acceptance rather than duplicate review.
9. Check `/version` and retain it with deployment evidence.

## Docker / Compose deployment

Use release assets:

```text
IMAGE_DIGEST.txt
compose.release.yaml
```

Create required secrets:

```bash
mkdir -p secrets
chmod 0700 secrets
printf '%s' "$GITLAB_API_TOKEN" > secrets/gitlab_api_token
printf '%s' "$GITLAB_WEBHOOK_SIGNING_TOKEN" > secrets/gitlab_webhook_signing_token
chmod 0600 secrets/*
```

Then:

```bash
docker compose -f compose.release.yaml up -d
curl -fsS http://127.0.0.1:8787/health/ready
```

Compose maps secrets under `/run/secrets/*`; no `env_file` is required for required credentials. Optional OpenAI/notification secrets can be added using the same `_FILE` contract.

## Reverse proxy

Terminate TLS at a trusted ingress/reverse proxy. Preserve the raw request body and Standard Webhooks signature headers. Do not modify signed payload bytes. Restrict direct access to service management endpoints where network policy allows.

## Backup before upgrade

```bash
npm run admin -- backup /secure-backup/pre-upgrade.sqlite
npm run admin -- backup-verify /secure-backup/pre-upgrade.sqlite
npm run admin -- drain 120
```

## Upgrade

From v5.0.0 onward, released DB/Config compatibility is an explicit product contract. Any future schema transition must be documented and tested.

1. Read release notes and rollback boundary.
2. Create/verify backup.
3. Drain durable work.
4. Verify new tgz/OCI digest and provenance.
5. Install/switch exact release artifact.
6. Run Doctor before enabling traffic.
7. Restart service/Runner.
8. Require `/health/ready`, `/version` and expected queue/outbox state.

## Rollback

Rollback is allowed only within the release's documented schema boundary. Never start an older binary against a newer irreversible DB/Config schema.

If rollback is compatible:

1. Stop Controller.
2. Restore the previous verified binary/image.
3. Restore the pre-upgrade database only if required by the release boundary.
4. Restore the matching Config Schema file.
5. Run Doctor.
6. Start and verify `/health/ready`, `/health/dependencies` and `/version`.

## Production rollout pattern

For a broad Project/Group scope, start with a small explicit Project set, validate queue age/token/latency, then widen scope. One instance should remain within one administrative/security trust domain. Use separate instances for materially different confidentiality or credential domains.

## Operational follow-up

See `OPERATIONS.md` for Admin CLI, backup/restore, incident response, SLO/capacity and fatal crash/restart semantics.
