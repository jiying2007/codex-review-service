# GitLab setup

1. Confirm the instance is GitLab Self-Managed **14.6.1 or newer**. The compatibility floor is not a recommendation to keep an old unsupported GitLab server; use a vendor-supported GitLab release when practical.
2. Create a Group or Project Access Token with only the API permissions required by Codex Review Service. Production should store it in a protected file and use `GITLAB_API_TOKEN_FILE`.
3. Create Config Schema 2 (`"schemaVersion": 2`) and configure explicit Project IDs and/or Group IDs in `config.json`.
4. Generate one `whsec_...` webhook secret and provide it through `GITLAB_WEBHOOK_SIGNING_TOKEN` or the production-preferred `GITLAB_WEBHOOK_SIGNING_TOKEN_FILE`; do not set both. On GitLab **<19.1**, enter that exact value in the webhook **Secret Token** field. On GitLab **>=19.1**, configure it as the Standard Webhooks Signing Token.
5. Add webhook URL `https://<host>/webhooks/gitlab` with **Merge request events** and **Note events**.
6. Run `npm run doctor`. Record the detected GitLab version, diff profile and `webhookAuth` capability, then verify `GET /health/ready`, `GET /health/dependencies`, and `GET /version`.
7. Create or update a disposable test MR and confirm GitLab `running` → terminal status, one summary, deterministic discussions, and no duplicate Review Run for a duplicate webhook.
8. Push a new source commit and confirm the previous immutable snapshot is superseded and stale publication does not overwrite the new result.
9. If IM notifications are enabled, verify the expected Feishu/WeCom route receives its deterministic card through `notification_outbox`; notification failure must not alter the GitLab verdict.
10. For Group-based scope, verify a complete refresh discovers the intended Projects and an incomplete/failed refresh preserves the last complete scope while `/health/dependencies` becomes degraded.

## Review assignment trigger

Automatic MR review is gated by `review.triggerAssignment`:

- `reviewer` (**default**) matches the GitLab **Reviewer** list. This is the recommended code-review workflow.
- `assignee` matches the GitLab Assignee list.
- `either` accepts a match in Reviewer or Assignee.
- `always` disables assignment gating; `userIds` must be empty.

For `reviewer`, `assignee`, and `either`, an empty `userIds` list means any current member in the selected role is sufficient. When `userIds` is non-empty, at least one current member must match a configured GitLab numeric user ID. Adding a matching Reviewer to an already-open MR triggers review even when there is no new source commit. Removing a Reviewer does not trigger review, and unrelated MR metadata updates remain ignored.

The explicit `/codex review` Note command bypasses assignment gating by design; existing Project allowlist, caller identity/access checks, bot self-checks, and all review safety gates still apply. Config Schema 2 hard-removes `requiredAssigneeUserIds` and `manualReviewBypassAssignee`; old files fail closed instead of being silently translated.

## Provider profiles

Doctor selects capabilities from authenticated `/api/v4/version`.

### Diff profile

- **Classic (`14.6.1` to `<15.7`)** uses `GET /projects/:id/merge_requests/:iid/changes`. The API response must contain `overflow: false`; `true` or a missing/unknown overflow signal blocks review before Codex.
- **Modern (`>=15.7`)** uses paginated `GET /projects/:id/merge_requests/:iid/diffs`, then requires `/versions` metadata and exact `real_size` agreement.

### Webhook authentication profile

- **Classic token (`<19.1`)** verifies GitLab's `X-Gitlab-Token` using constant-time comparison. Because these GitLab versions do not provide the Standard Webhooks timestamp/HMAC replay-window contract, the Service derives deterministic delivery identity from event type plus SHA-256 of the raw body. Use trusted HTTPS/private ingress and source-network restrictions where available.
- **Standard HMAC (`>=19.1`)** requires provider delivery identity, timestamp replay window, HMAC-SHA256 over the exact raw body and expected GitLab instance.

Do not configure a manual profile override. Capability selection is deterministic from the GitLab version so operators cannot accidentally weaken completeness or webhook guarantees.

## Permanent compatibility evidence

The repository system matrix runs the complete provider contract against real GitLab CE **14.6.1**, **17.11.7**, and **19.3.0**. The matrix creates a real Group/Project/MR, retrieves complete diffs through the selected profile, publishes notes/discussions/status, resolves a discussion, verifies repository/scope behavior, and verifies the webhook-auth capability selected for the real GitLab version.

Production acceptance should still be repeated against the actual Self-Managed instance because local permissions, hooks, diff limits and network policy are deployment-specific. For Classic installations, include an overflowed MR fixture and confirm it is blocked rather than partially reviewed.

GitLab server upgrades remain an independent infrastructure lifecycle. Follow GitLab's official required upgrade stops and background migration rules rather than upgrading across several major versions only to satisfy Codex Review Service.
## Flow Tracking hooks

When `flowTracking.enabled=true`, enable only the GitLab hooks required by the configured families: Pipeline events for Pipeline Tracking, Tag Push events for Tag Tracking, and Push events for Branch create/delete Tracking. Flow events reuse the same authenticated webhook endpoint, allowlist and durable dedupe path. They never invoke Codex.
