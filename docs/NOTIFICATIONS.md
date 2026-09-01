# IM Notifications

Codex Review Service can deliver deterministic review cards to Feishu/Lark and WeCom group robots. Notifications are an attention channel only: SQLite remains the durable service source of truth and GitLab remains the review system of record.

## Reliability model

A completed review persists GitLab publication actions and notification actions in the same SQLite transaction. A terminal failed review persists its failed job state and `review.failed` notification actions in one transaction as well. `notification_outbox` has independent retries, idempotency keys, restart recovery, and a terminal failed state. Notification failure never changes a review verdict and never reruns Codex.

## Routes and secrets

Enable `notifications.enabled` in Config Schema 6 and define routes. Routes may target explicit `projects`, GitLab `groups`, or all resolved service projects when both are empty. Each route selects `feishu`, `feishu_app`, or `wecom`, a `secretRef`, and optional event filtering.

`secretRef: "embedded"` resolves the webhook from `CODEX_REVIEW_NOTIFY_EMBEDDED_WEBHOOK` or the production-preferred file form `CODEX_REVIEW_NOTIFY_EMBEDDED_WEBHOOK_FILE`. A direct value and `_FILE` form are mutually exclusive. Webhook URLs are never stored in JSON or SQLite. Feishu routes require official `open.feishu.cn`/`open.larksuite.com` bot URLs; WeCom routes require `qyapi.weixin.qq.com`.

When Feishu/Lark custom-bot signature verification is enabled, use `CODEX_REVIEW_NOTIFY_<REF>_SIGNING_SECRET` or `CODEX_REVIEW_NOTIFY_<REF>_SIGNING_SECRET_FILE`. The service generates timestamp/HMAC-SHA256/Base64 at delivery time; the signing secret is never persisted. Docker production should mount these as Compose secrets under `/run/secrets/*`; system deployments should use protected local files.

`feishu_app` is the directed application-bot provider. It reads `CODEX_REVIEW_NOTIFY_<REF>_APP_ID`, `CODEX_REVIEW_NOTIFY_<REF>_APP_SECRET`, and `CODEX_REVIEW_NOTIFY_<REF>_CHAT_ID` (or their mutually-exclusive `_FILE` forms). `CHAT_ID` must be an `oc_…` group ID. The service acquires and caches `tenant_access_token`, then calls `POST /im/v1/messages?receive_id_type=chat_id` with the same deterministic interactive card. No credential, tenant token, or chat ID is persisted in `notification_outbox`.

Set `statusCard: true` only on a `feishu_app` route to send one durable running card and PATCH it to the final review result. `review_status_cards` persists the job/route/message association; restart recovery preserves the outbox, and a terminal create failure degrades the final result to a normal one-shot card. Routes also accept `branches`, `severities`, `authors`, `reviewers`, `language`, and an optional read-only `diagnosticsUrl`. Without a card callback endpoint no state-changing card actions are exposed.

Concurrent token acquisition for one App is single-flight. Send and PATCH operations are throttled to 20 RPS, and provider/HTTP `Retry-After` overrides exponential delay within the configured maximum. Serialized Feishu cards have a 28,000-byte safety gate and deterministically degrade to a compact result plus the primary link when necessary.

Commit pushes use a 30-second pending aggregation window per project, branch and route. Schema 8 generated columns and composite indexes expose aggregation key/deadline, operation type and status-card Job ID without full-table JSON parsing. The final card expands at most three commits while retaining the total count. Pipeline state tracking suppresses duplicate states and publishes only configured terminal states. MR correlation requires project, source branch, a 24-hour freshness window and an available matching head SHA; otherwise events remain independent.

Review, Push, Pipeline, MR, Tag, and branch cards display a repository path. Review events prefer GitLab `references.full` with the `!IID` suffix removed; Flow events use the webhook `project.path_with_namespace`. A missing trusted path suppresses the field rather than substituting an unstable project ID.

## Responsible-owner delivery

`notifications.identities` maps a GitLab numeric user ID (preferred) or username to a Feishu `open_id`; display-name matching is intentionally unsupported. A `feishu_app` route may configure `responsibility` with an ordered Reviewer → Assignee → Author fallback, attention events/severities, a bounded mention count, and optional `directMessage` delivery. On a matching blocked or failed Review, the final group card renders trusted mapped mentions only. Direct messages use `receive_id_type=open_id`, have per-recipient outbox dedupe keys, and cannot change the group-card result or the Review Verdict when they fail. Direct messages are terminal one-shot cards, so they never compete with the durable group status-card `message_id`.

`provider_accepted` means that Feishu accepted the API request and created the message conversation; it is not a user-read or operating-system-notification receipt. Client visibility, do-not-disturb state, and application notification settings remain user/admin controlled.

The smoke command is dry-run unless `--send` is explicit:

```bash
npm run admin -- smoke-feishu-card <feishu_app-route>
npm run admin -- smoke-feishu-card <feishu_app-route> --send
```

Doctor reports potentially overlapping routes, suppressed unsafe diagnostics URLs, and severity-filtered status-card routes that can only produce a final one-shot card.

Default events are intentionally quiet: `review.blocked`, `review.failed`, and `service.degraded`. Add `review.completed` explicitly for audit channels.

## Cards

Cards are deterministic local renderings of validated review data. Feishu uses an interactive card with `div` + `lark_md` content; WeCom uses a `text_notice` template card with the required `card_action`. Review cards link to the GitLab MR. Service-only WeCom alerts use the neutral WeCom landing page as the mandatory card action because the service has no canonical public URL.

MR titles, branch names, Finding titles/files, error codes and system detail values are normalized before they enter the durable notification event so control characters and card/Markdown metacharacters cannot become active card markup. MR links accept only credential-free HTTP(S) URLs.

Cards include verdict, MR identity, short HEAD SHA, severity counts, duration, and up to `topFindings`. Delivery never performs an extra reviewed-repository fetch just to enrich a card. Cards never include raw diff, prompts, secrets, full receipts, or unvalidated model claims.

## Retry and terminal failure

Retry applies only to network errors, HTTP 408/409/425/429, 5xx, and explicitly classified transient Feishu API codes. Invalid credentials, missing bot permission, invalid chat IDs, malformed cards, and other permanent provider/configuration errors fail closed into `notification_outbox.status=failed`. A rejected cached Feishu token is invalidated and refreshed once before its outbox attempt is classified. Prometheus metrics expose queue state and oldest notification age.

After fixing the underlying provider/secret problem, an operator may explicitly retry one terminal failed delivery without changing the Review Verdict or rerunning Codex:

```bash
npm run admin -- notifications
npm run admin -- retry-notification <id>
```

Do not delete `notification_outbox` rows as an incident workaround.


Notification event timestamps are canonical UTC ISO-8601 values and review notifications use the exact persisted Review Receipt time, not delayed delivery time.
## GitLab Flow events

Config Schema 4 can route deterministic `gitlab.pipeline.*`, `gitlab.mr.*`, `gitlab.tag.*` and `gitlab.branch.*` events through the same durable outbox. Acquisition is controlled by `flowTracking`; delivery remains controlled by `notifications.routes[].events`. Flow cards are local deterministic formatters and consume zero Codex tokens. See `FLOW_TRACKING.md`.

## Commit Push notifications

`gitlab.push.committed` is a deterministic aggregated notification containing branch, pusher, before/after range, total commit count, and bounded commit summaries. It never fetches extra GitLab diff data and never invokes Codex.
