# Docker deployment

1. Copy the repository `config.example.json` to `deploy/docker/config.json`, set `server.host` to `0.0.0.0`, and set `server.dataDir` to `/var/lib/codex-review`.
2. Copy `.env.example` to `deploy/docker/.env`; set GitLab credentials and optional `CODEX_REVIEW_NOTIFY_<REF>_WEBHOOK` secrets.
3. Start with `docker compose -f deploy/docker/compose.yaml up -d --build`.
4. Authenticate Codex in the persisted home volume or provide `OPENAI_API_KEY`.
5. Verify `curl -fsS http://127.0.0.1:8787/health/ready`.

The container runs as a non-root user, drops Linux capabilities, uses a read-only root filesystem, and persists only service state and the Codex home. The default build pins `@openai/codex` 0.149.1; startup still runs the Safe Contract capability probe and fails closed if the CLI is incompatible.
