# IM Notifications

Codex Review Service can deliver deterministic review cards to Feishu/Lark and WeCom group robots. Notifications are an attention channel only: SQLite remains the durable service source of truth and GitLab remains the review system of record.

## Reliability model

A completed review persists GitLab publication actions and notification actions in the same SQLite transaction. `notification_outbox` has independent retries, idempotency keys, and a terminal failed state. Notification failure never changes a review verdict and never reruns Codex.

## Routes

Enable `notifications.enabled` and define routes. Routes may target explicit `projects`, GitLab `groups`, or all resolved service projects when both are empty. Each route selects `feishu` or `wecom`, a `secretRef`, and optional event filtering.

`secretRef: "embedded"` resolves only from `CODEX_REVIEW_NOTIFY_EMBEDDED_WEBHOOK`. Webhook URLs are never stored in JSON or SQLite. Feishu routes require official `open.feishu.cn`/`open.larksuite.com` bot URLs; WeCom routes require `qyapi.weixin.qq.com`.

Default events are intentionally quiet: `review.blocked`, `review.failed`, and `service.degraded`. Add `review.completed` explicitly for audit channels.

## Cards

Cards are deterministic local renderings of validated review data. They include verdict, MR identity, short HEAD SHA, severity counts, duration, up to `topFindings`, and an MR link. They never include raw diff, prompts, secrets, full receipts, or unvalidated model claims.

## Retry and dead letter

Retry applies only to network errors, HTTP 408/409/425/429, and 5xx. Permanent provider/configuration errors fail closed into `notification_outbox.status=failed`. Prometheus metrics expose queue and delivery state.
