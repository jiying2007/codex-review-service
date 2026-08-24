# IM 通知

Codex Review Service 支持把确定性 Review 卡片推送到飞书/Lark 与企业微信群机器人。IM 只负责吸引注意力：SQLite 仍是 Service durable source of truth，GitLab 仍是 Review system of record。

## 可靠性模型

Review 成功完成时，GitLab publication actions 与 notification actions 在同一个 SQLite transaction 中持久化；Review 最终失败时，failed job 状态与 `review.failed` notification actions 也在同一个 transaction 中持久化。`notification_outbox` 独立重试、独立幂等、支持重启恢复，并有独立 failed 终态；通知失败不会改变 Review Verdict，也绝不会重新运行 Codex。

## Route 与 Secret

开启 `notifications.enabled` 并配置 routes。Route 可按明确 `projects`、GitLab `groups` 路由；两者都为空时表示当前 Service 已解析的全部 Project。每个 Route 指定 `feishu` 或 `wecom`、`secretRef` 与可选事件过滤。

`secretRef: "embedded"` 只从 `CODEX_REVIEW_NOTIFY_EMBEDDED_WEBHOOK` 读取。Webhook URL 不进入 JSON 或 SQLite。飞书只允许官方 `open.feishu.cn`/`open.larksuite.com` Bot URL；企业微信只允许 `qyapi.weixin.qq.com`。

如果飞书/Lark 自定义机器人开启了签名校验，再配置 `CODEX_REVIEW_NOTIFY_<REF>_SIGNING_SECRET`。Service 在真正投递时生成 timestamp + HMAC-SHA256 + Base64 签名，签名 Secret 不进入 SQLite。企业微信群机器人的凭据继续只存在于 Webhook Secret URL 中，不会写入卡片或日志。

默认事件保持克制：`review.blocked`、`review.failed`、`service.degraded`。需要审计群时显式增加 `review.completed`。

## 卡片

卡片完全由本地确定性 formatter 生成。飞书使用 `div + lark_md` 的 interactive card；企业微信使用 `text_notice` template card，并始终提供协议要求的 `card_action`。Review 卡片点击进入 GitLab MR；Service-only 企业微信告警由于没有 canonical public service URL，必填 card action 使用企业微信中性入口。

MR Title、Branch、Finding Title/File、Error Code 和系统 Detail 在进入 durable notification event **之前**就完成控制字符与卡片/Markdown 元字符净化；MR URL 只接受不含凭据与 fragment 的 HTTP(S) 地址。

卡片只包含 Verdict、MR、短 HEAD、Severity 数量、耗时、最多 `topFindings` 条 Finding 与已有 MR 链接。不会推送 raw diff、Prompt、Secret、完整 Receipt，也不会让 AI 自由生成卡片文案。

## 重试与 Dead Letter

仅网络错误、HTTP 408/409/425/429 与 5xx 自动重试。Provider/配置永久错误进入 `notification_outbox.status=failed`，Prometheus Metrics 暴露通知 Queue 与终态。
