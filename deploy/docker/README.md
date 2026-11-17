# Docker deployment

## Production rule

Production consumes the **release-published OCI digest** and `compose.release.yaml`. Do not run `docker compose ... --build` on production hosts.

The source-tree `deploy/docker/compose.yaml` is the development/reference template. Release rewrites its `image:` to `ghcr.io/jiying2007/codex-review-service:<version>@sha256:...` and publishes that immutable manifest.

## Prepare configuration

Copy the Docker config example and edit it:

```bash
cp deploy/docker/config.example.json deploy/docker/config.json
```

The file already uses:

```text
schemaVersion = 8
server.host = 0.0.0.0
server.dataDir = /var/lib/codex-review
```

## Prepare required secrets

```bash
cd deploy/docker
mkdir -p secrets
chmod 0700 secrets
printf '%s' "$GITLAB_API_TOKEN" > secrets/gitlab_api_token
printf '%s' "$GITLAB_WEBHOOK_SIGNING_TOKEN" > secrets/gitlab_webhook_signing_token
chmod 0600 secrets/*
```

Compose mounts these under `/run/secrets/*` and passes only `_FILE` paths to the service. Required credentials do not use `env_file`.

Optional OpenAI and notification secrets follow the same runtime contract, for example:

```text
OPENAI_API_KEY_FILE=/run/secrets/openai_api_key
CODEX_REVIEW_NOTIFY_TEAM_WEBHOOK_FILE=/run/secrets/notify_team_webhook
CODEX_REVIEW_NOTIFY_TEAM_SIGNING_SECRET_FILE=/run/secrets/notify_team_signing_secret
CODEX_REVIEW_NOTIFY_FEISHU_APP_REVIEW_APP_ID_FILE=/run/secrets/notify_feishu_app_review_app_id
CODEX_REVIEW_NOTIFY_FEISHU_APP_REVIEW_APP_SECRET_FILE=/run/secrets/notify_feishu_app_review_app_secret
CODEX_REVIEW_NOTIFY_FEISHU_APP_REVIEW_CHAT_ID_FILE=/run/secrets/notify_feishu_app_review_chat_id
```

Add matching Compose `secrets:` entries only for routes you enable.

## Start a released image

From a GitHub Release, download and verify `compose.release.yaml`, `IMAGE_DIGEST.txt` and `SHA256SUMS`, then:

```bash
docker compose -f compose.release.yaml up -d
curl -fsS http://127.0.0.1:8787/health/ready
curl -fsS http://127.0.0.1:8787/health/dependencies
curl -fsS http://127.0.0.1:8787/version
```

## Runtime hardening

The image:

- is based on Node 24.19.0 Debian 13 trixie-slim pinned by multi-platform digest;
- pins the default `@openai/codex` version while still requiring Safe Contract capability probing at startup;
- runs as non-root `codex-review`;
- drops all Linux capabilities;
- uses `no-new-privileges`;
- uses a read-only root filesystem;
- uses tmpfs only for `/tmp`;
- persists only `/var/lib/codex-review` state and Codex home;
- binds the host port to `127.0.0.1` by default;
- applies CPU/memory bounds in the Compose model.

## Image supply chain

Release publishes a multi-architecture `linux/amd64,linux/arm64` image to GHCR. Required CI builds and scans both native architectures. The publisher verifies the original OCI index and child-manifest bytes, then scans each exact child digest with Trivy 0.70.0. Every Critical vulnerability and every High with an available fix blocks publication, including Critical findings without a fix. Raw JSON inventories and derived SARIF are preserved on failure and included in successful release checksums and attestations.

The official runtime keeps Node 24.19.0 and uses an exact-pinned Debian 13 trixie-slim base. It requires the nine patched packages in the security baseline below. Bootstrap APT commands disable retries before upgrading APT itself. Both the build and the actual per-platform scan inventory verify these minimum versions, including Debian epoch and revision fields. These fixes follow Debian's [APT advisory](https://security-tracker.debian.org/tracker/CVE-2026-109518) and [PCRE2 advisory](https://security-tracker.debian.org/tracker/CVE-2026-103111).

### Security baseline

Both native images and raw scan inventories must meet every Debian 13 minimum:

| Package | Minimum version |
| --- | --- |
| `apt` | `3.0.4` |
| `libapt-pkg7.0` | `3.0.4` |
| `libpcre2-8-0` | `10.46-1~deb13u3` |
| `zlib1g` | `1:1.3.dfsg+really1.3.1-1+deb13u1` |
| `gzip` | `1.13-1+deb13u1` |
| `libsqlite3-0` | `3.46.1-7+deb13u2` |
| `libssl3t64` | `3.5.7-1~deb13u3` |
| `openssl-provider-legacy` | `3.5.7-1~deb13u3` |
| `perl-base` | `5.40.1-6+deb13u1` |

Unfixed High findings remain visible in the original reports. Every Critical remains blocking regardless of fix status.

BuildKit emits per-platform SBOM/provenance metadata, and GitHub build provenance is attached to the canonical image digest. `OCI_SCAN_TARGETS.json` records the index, child-manifest and config digest relationships; `BUILD_EVIDENCE.json` binds the original scans and SARIF to that same release identity.

Verify the digest/attestation as described in `VERIFY_RELEASE.md` before deployment.

## Codex authentication

If using `OPENAI_API_KEY_FILE`, mount it as a Compose secret. If using `codex login`, authenticate into the persisted Codex home volume using an explicit maintenance procedure and restrict access to that volume as a credential asset.

## Backup and upgrade

The state volume contains the live SQLite database. Before image upgrades:

```bash
npm run admin -- backup /secure-backup/pre-upgrade.sqlite
npm run admin -- backup-verify /secure-backup/pre-upgrade.sqlite
npm run admin -- drain 120
```

Then switch only to the verified new digest. Rollback must respect the release's DB/Config Schema boundary.


## Sharded multi-GitLab deployment (opt-in)

For separate OS processes, use the profile-gated `compose.sharded.yaml` with its stateless native `src/sharded-edge.js` ingress after reading [the isolated deployment/runbook](../../docs/MULTI_GITLAB_SHARDED.zh-CN.md). The edge uses the same verified Service OCI digest, but has **no GitLab/model credentials** and never starts a Review Worker. The older `nginx.sharded.conf` is kept only as a reference. The existing `compose.multi.yaml` remains supported for same-trust-domain worker-thread isolation. Neither template grants production approval or disables model execution by toggling notifications. Always validate exact image digests, isolated single-writer volumes, preflight and rollback before a controlled cutover.

Generate the bounded, no-secret repository catalog before any sharded preflight:

```bash
node src/sharded-catalog.js deploy/docker/legacy.json deploy/docker/sensor.json > deploy/docker/catalog.json
node src/sharded-deploy-check.js deploy/docker
```

The native edge serves read-only `/repositories`, `/metrics`, `/health/ready`, `/health/ingress` and per-instance readiness and metrics; no authenticated GitLab API calls or model execution are performed by these endpoints. External HTTPS proxies should forward **only explicit POST Webhook paths**; never expose operational management/metrics endpoints publicly. A partial ingress 200 does not imply all tenants are healthy.
