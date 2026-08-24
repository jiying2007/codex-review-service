# IM Notifications

Codex Review Service can deliver deterministic review cards to Feishu/Lark and WeCom group robots. Notifications are an attention channel only: SQLite remains the durable service source of truth and GitLab remains the review system of record.

## Reliability model

A completed review persists GitLab publication actions and notification actions in the same SQLite transaction. A terminal failed review persists its failed job state and `review.failed` notification actions in one transaction as well. `notification_outbox` has independent retries, idempotency keys, restart recovery, and a terminal failed state. Notification failure never changes a review verdict and never reruns Codex.

## Routes and secrets

Enable `notifications.enabled` and define routes. Routes may target explicit `projects`, GitLab `groups`, or all resolved service projects when both are empty. Each route selects `feishu` or `wecom`, a `secretRef`, and optional event filtering.

`secretRef: "embedded"` resolves the webhook only from `CODEX_REVIEW_NOTIFY_EMBEDDED_WEBHOOK`. Webhook URLs are never stored in JSON or SQLite. Feishu routes require official `open.feishu.cn`/`open.larksuite.com` bot URLs; WeCom routes require `qyapi.weixin.qq.com`.

When Feishu/Lark custom-bot signature verification is enabled, also set `CODEX_REVIEW_NOTIFY_<REF>_SIGNING_SECRET`. The service generates the timestamp/HMAC-SHA256/Base64 signature at delivery time; the signing secret is never persisted. WeCom robot credentials remain contained in the webhook secret URL and are never rendered into cards or logs.

Default events are intentionally quiet: `review.blocked`, `review.failed`, and `service.degraded`. Add `review.completed` explicitly for audit channels.

## Cards

Cards are deterministic local renderings of validated review data. Feishu uses an interactive card with `div` + `lark_md` content; WeCom uses a `text_notice` template card with the required `card_action`. Review cards link to the GitLab MR. Service-only WeCom alerts use the neutral WeCom landing page as the mandatory card action because the service has no canonical public URL.

MR titles, branch names, Finding titles/files, error codes and system detail values are normalized before they enter the durable notification event so control characters and card/Markdown metacharacters cannot become active card markup. MR links accept only credential-free HTTP(S) URLs.

Cards include verdict, MR identity, short HEAD SHA, severity counts, duration, and up to `topFindings`. Delivery never performs an extra reviewed-repository fetch just to enrich a card. Cards never include raw diff, prompts, secrets, full receipts, or unvalidated model claims.

## Retry and dead letter

Retry applies only to network errors, HTTP 408/409/425/429, and 5xx. Permanent provider/configuration errors fail closed into `notification_outbox.status=failed`. Prometheus metrics expose queue and delivery state.
