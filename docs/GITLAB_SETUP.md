# GitLab setup

1. Confirm the instance is GitLab Self-Managed **14.6.1 or newer**. The compatibility floor is not a recommendation to keep an old unsupported GitLab server; use a vendor-supported GitLab release when practical.
2. Create a Group or Project Access Token with only the API permissions required by Codex Review Service. Production should store it in a protected file and use `GITLAB_API_TOKEN_FILE`.
3. Create Config Schema 1 (`"schemaVersion": 1`) and configure explicit Project IDs and/or Group IDs in `config.json`.
4. Configure a Standard Webhooks Signing Token. Use the same value through `GITLAB_WEBHOOK_SIGNING_TOKEN` or the production-preferred `GITLAB_WEBHOOK_SIGNING_TOKEN_FILE`; do not set both.
5. Add webhook URL `https://<host>/webhooks/gitlab` with **Merge request events** and **Note events**.
6. Run `npm run doctor`. Record the detected GitLab version and provider profile, then verify `GET /health/ready`, `GET /health/dependencies`, and `GET /version`.
7. Create or update a disposable test MR and confirm GitLab `running` → terminal status, one summary, deterministic discussions, and no duplicate Review Run for a duplicate webhook.
8. Push a new source commit and confirm the previous immutable snapshot is superseded and stale publication does not overwrite the new result.
9. If IM notifications are enabled, verify the expected Feishu/WeCom route receives its deterministic card through `notification_outbox`; notification failure must not alter the GitLab verdict.
10. For Group-based scope, verify a complete refresh discovers the intended Projects and an incomplete/failed refresh preserves the last complete scope while `/health/dependencies` becomes degraded.

## Provider profiles

Doctor selects the profile from authenticated `/api/v4/version`:

- **Classic (`14.6.1` to `<15.7`)** uses `GET /projects/:id/merge_requests/:iid/changes`. The API response must contain `overflow: false`; `true` or a missing/unknown overflow signal blocks review before Codex.
- **Modern (`>=15.7`)** uses paginated `GET /projects/:id/merge_requests/:iid/diffs`, then requires `/versions` metadata and exact `real_size` agreement.

Do not configure a manual profile override. Capability selection is deterministic from the GitLab version so operators cannot accidentally weaken completeness guarantees.

## Permanent compatibility evidence

The repository system matrix runs the complete provider contract against real GitLab CE **14.6.1**, **17.11.7**, and **19.3.0**. The matrix creates a real Group/Project/MR, retrieves complete diffs through the selected profile, publishes notes/discussions/status, resolves a discussion, and verifies repository/scope behavior.

Production acceptance should still be repeated against the actual Self-Managed instance because local permissions, hooks, diff limits and network policy are deployment-specific. For Classic installations, include an overflowed MR fixture and confirm it is blocked rather than partially reviewed.

GitLab server upgrades remain an independent infrastructure lifecycle. Follow GitLab's official required upgrade stops and background migration rules rather than upgrading across several major versions only to satisfy Codex Review Service.
