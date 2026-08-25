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
schemaVersion = 1
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

- is based on Node 24.19.0 Bookworm slim pinned by multi-platform digest;
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

Release publishes a multi-architecture `linux/amd64,linux/arm64` image to GHCR. BuildKit emits OCI SBOM/provenance metadata, the release workflow performs a High/Critical vulnerability scan, and GitHub build provenance is attached to the canonical image digest.

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
