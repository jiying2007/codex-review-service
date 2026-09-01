# Production Deployment

## Supported baseline

Read `product-contract.json` before deployment. **Codex Review Service 7.3.0** supports native/systemd Node.js **22 LTS >=22.22.2** or **24 LTS >=24.19.0**, GitLab Self-Managed **>=14.6.1**, Database Schema 8 and **Config Schema 7**. The official Docker image uses canonical Node 24.19.0.

Safe Core is exact-pinned to `7878dae982088746c06e4fe747b2468e6af274a2`. Do not replace the gitlink or copy another Core runtime into a release package.

GitLab 14.6.1 is a compatibility floor, not a lifecycle recommendation. Real provider CI covers GitLab CE 14.6.1, 17.11.7 and 19.3.0.

## Config Schema 7 Provider Contract boundary

Service 7.3.0 hard-cuts Config Schema 6 -> 7 for Core Provider Contract v2. Runtime does not translate Config Schema 6. Before rollout, set `schemaVersion: 7`; `codex.credentialSource` is `auto|env|auth-json` and `codex.allowInsecureHttp` defaults to `false`. Non-loopback HTTP is accepted only when explicitly enabled for a trusted relay. The Service 7.2.0 Config Schema 5 -> 6 responsibility-notification boundary and the prior `review.incrementalReviewEnabled` retirement remain historical upgrade boundaries.

The quality surface is now:

```json
{
  "schemaVersion": 7,
  "gitlab": {
    "baseUrl": "https://gitlab.example.internal",
    "projects": [101, 102],
    "groups": [{"id": 20, "includeSubgroups": true}]
  },
  "review": {
    "profile": "general",
    "analyzerReports": [
      {"format":"sarif","job":"security-*","path":"reports/security.sarif","required":false,"maxBytes":4194304},
      {"format":"junit","job":"test-*","path":"junit.xml","required":false,"maxBytes":4194304}
    ],
    "testImpactEnabled": true,
    "testPathPrefixes": ["test/", "tests/"],
    "maxTestCandidates": 200,
    "maxRecommendedTests": 40,
    "triggerAssignment": {"mode":"reviewer","userIds":[]}
  },
  "codex": {
    "providerMode": "openai-compatible",
    "providerBaseUrl": "http://192.168.2.109:3000/v1",
    "apiKeyEnv": "CODEX_PROVIDER_API_KEY",
    "credentialSource": "auth-json",
    "allowInsecureHttp": true
  }
}
```

`analyzerReports` references CI artifacts that already exist. The Service never executes repository-defined analyzer commands. Test Impact recommends tests from the exact MR head SHA; it never executes tests or turns a recommendation into test-pass evidence.

## GitLab capability profiles

The service chooses capabilities from authenticated `/api/v4/version`:

- **Classic diff** (`14.6.1` to `<15.7`): `/merge_requests/:iid/changes`; `overflow` must be exactly `false`.
- **Modern diff** (`>=15.7`): paginated `/diffs` plus `/versions.real_size` proof.
- **Classic webhook auth** (`<19.1`): `X-Gitlab-Token` plus deterministic raw-body identity; use trusted HTTPS/private ingress and source-network restrictions.
- **Standard HMAC webhook auth** (`>=19.1`): signed identity, timestamp replay window and raw-body HMAC-SHA256.

All profiles fail closed when their available guarantees cannot be proven. There is no manual compatibility override.

## Choose a deployment mode

### Standard systemd / inline Runner

Recommended default. Controller, SQLite, GitLab provider and Codex execution run as one Unix service user.

### Hardened systemd / isolated Runner

Use when GitLab credentials and OpenAI/Codex credentials must live in separate Unix users/processes. Controller owns GitLab/state; Runner owns Codex/OpenAI credentials and exposes only the Unix-socket Safe Contract.

### Docker / Compose

Use the release-published `compose.release.yaml` and canonical GHCR digest. Do not rebuild source on production hosts.

## Install the verified release

Verify checksums and provenance first; see `VERIFY_RELEASE.md`. For systemd:

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo install -d -o root -g codex-review -m 0750 /etc/codex-review/secrets
sudo install -d -o codex-review -g codex-review -m 0700 /var/lib/codex-review
sudo install -m 0644 deploy/systemd/config.example.json /etc/codex-review/config.json
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/
```

Create protected secret files and use `_FILE` inputs:

```text
GITLAB_API_TOKEN_FILE=/etc/codex-review/secrets/gitlab-api-token
GITLAB_WEBHOOK_SIGNING_TOKEN_FILE=/etc/codex-review/secrets/gitlab-webhook-signing-token
OPENAI_API_KEY_FILE=/etc/codex-review/secrets/openai-api-key
```

Direct and `_FILE` forms are mutually exclusive. Secrets do not belong in Config Schema 7 JSON. With `credentialSource: "auth-json"`, the provider key may instead remain in the configured Codex home `auth.json`; the key value still never belongs in service JSON.

## Doctor preflight

```bash
cd /opt/codex-review-service
sudo -u codex-review /usr/bin/node --env-file=/etc/codex-review-service.env src/doctor.js
```

Doctor validates product/config identity, SQLite Schema 8/integrity, Codex Runtime, GitLab version/profile and complete Project/Group scope.

## Start and health

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
curl -fsS http://127.0.0.1:8787/health/live
curl -fsS http://127.0.0.1:8787/health/ready
curl -fsS http://127.0.0.1:8787/health/dependencies
curl -fsS http://127.0.0.1:8787/version
```

For isolated mode, enable `codex-review-runner` before the Controller.

## Configure GitLab webhook

Expose trusted HTTPS ingress to:

```text
https://<review-host>/webhooks/gitlab
```

Enable **Merge request events** and **Note events** for Review. When `flowTracking.enabled=true`, additionally enable only the event families actually configured: **Pipeline events**, **Tag Push events**, and/or **Push events** for Branch create/delete tracking. Configure the webhook token/signing token according to Doctor's detected capability. Do not enable traffic until Doctor and `/health/ready` pass.

## End-to-end acceptance

For a disposable MR:

1. Run Doctor and record GitLab version/profile.
2. Open or update the MR.
3. Confirm one durable Review Job is queued.
4. Confirm terminal GitLab status, summary and discussions.
5. Confirm Analyzer Adapter evidence is acquired only from the exact head pipeline when configured.
6. Confirm Test Impact recommendations contain no claim that tests were executed.
7. Push a new commit and verify stale publication is prevented.
8. Send a duplicate webhook and verify idempotent handling.
9. Check `/version` and `/health/dependencies`.
10. If notifications are enabled, verify the deterministic Feishu/WeCom path without changing the Review Verdict.
11. If Flow Tracking is enabled, verify a subscribed Pipeline/MR/Tag/Branch transition reaches `flow_state` and `notification_outbox` without starting Codex.

## Docker / Compose deployment

Use release assets:

```text
IMAGE_DIGEST.txt
compose.release.yaml
```

Create secret files under `./secrets`, then:

```bash
docker compose -f compose.release.yaml up -d
curl -fsS http://127.0.0.1:8787/health/ready
```

Compose maps required credentials through `/run/secrets/*`.

## Backup before upgrade

```bash
npm run admin -- backup /secure-backup/pre-upgrade.sqlite
npm run admin -- backup-verify /secure-backup/pre-upgrade.sqlite
npm run admin -- drain 120
```

## Upgrade and rollback

From v5.0.0 onward, released DB/Config compatibility is an explicit product contract. Service 7.3.0 introduces the current **Config Schema 6 -> 7** hard cut for Provider Contract v2 credentials/transport controls. Service 7.2.0 introduced the historical **Config Schema 5 -> 6** hard cut for strict responsibility identity mappings, and Service 7.0.0 introduced the historical **Config Schema 4 -> 5** hard cut and retired `review.incrementalReviewEnabled`. Runtime translates none of these configuration versions.

The historic Database Schema 5 -> 6 startup migration remains explicit and tested. Schema 7 -> 8 creates and verifies a Schema 7 backup before adding status-card state. Rollback requires restoring the backup matching the target release; do not attempt an in-place Schema 8 downgrade.

Upgrade sequence:

1. Read release notes and rollback boundary.
2. Create and verify backup.
3. Drain durable work.
4. Rewrite Config Schema 7 and explicitly review `codex.credentialSource` / `codex.allowInsecureHttp`.
5. Verify new tgz/OCI digest and provenance.
6. Install the exact release artifact.
7. Run Doctor before traffic.
8. Require `/health/ready`, `/version` and expected queue/outbox state.

Rollback only with the matching release artifact, configuration schema and verified database backup required by that release.
