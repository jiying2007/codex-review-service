# GitLab setup

1. Create a Group or Project Access Token with only the API permissions required by Codex Review Service. Production should store it in a protected file and use `GITLAB_API_TOKEN_FILE`.
2. Create Config Schema 1 (`"schemaVersion": 1`) and configure explicit Project IDs and/or Group IDs in `config.json`.
3. Configure a GitLab Self-Managed 19.1+ Standard Webhooks Signing Token. Use the same value through `GITLAB_WEBHOOK_SIGNING_TOKEN` or the production-preferred `GITLAB_WEBHOOK_SIGNING_TOKEN_FILE`; do not set both.
4. Add webhook URL `https://<host>/webhooks/gitlab` with **Merge request events** and **Note events**.
5. Run `npm run doctor`, then verify `GET /health/ready`, `GET /health/dependencies`, and `GET /version`.
6. Create or update a disposable test MR and confirm GitLab `running` → terminal status, one summary, deterministic discussions, and no duplicate Review Run for a duplicate webhook.
7. Push a new source commit and confirm the previous immutable snapshot is superseded and stale publication does not overwrite the new result.
8. If IM notifications are enabled, verify the expected Feishu/WeCom route receives its deterministic card through `notification_outbox`; notification failure must not alter the GitLab verdict.
9. For Group-based scope, verify a complete refresh discovers the intended Projects and an incomplete/failed refresh preserves the last complete scope while `/health/dependencies` becomes degraded.

The repository's permanent system matrix runs this provider contract against real GitLab CE at the minimum supported 19.1 line and a current certified line. Production acceptance should still be repeated against the actual Self-Managed instance because local permissions, hooks and network policy are deployment-specific.
