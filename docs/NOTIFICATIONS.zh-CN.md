# IM 通知

Codex Review Service 支持把确定性 Review 卡片推送到飞书/Lark 与企业微信群机器人。IM 只负责吸引注意力：SQLite 仍是 Service durable source of truth，GitLab 仍是 Review system of record。

## 可靠性模型

Review 完成后，GitLab publication actions 与 notification actions 在同一个 SQLite transaction 中持久化。`notification_outbox` 独立重试、独立幂等、独立进入 failed 终态；通知失败不会改变 Review Verdict，也绝不会重新运行 Codex。

## Route

开启 `notifications.enabled` 并配置 routes。Route 可按明确 `projects`、GitLab `groups` 路由；两者都为空时表示当前 Service 已解析的全部 Project。每个 Route 指定 `feishu` 或 `wecom`、`secretRef` 与可选事件过滤。

`secretRef: "embedded"` 只从 `CODEX_REVIEW_NOTIFY_EMBEDDED_WEBHOOK` 读取。Webhook URL 不进入 JSON 或 SQLite。飞书只允许官方 `open.feishu.cn`/`open.larksuite.com` Bot URL；企业微信只允许 `qyapi.weixin.qq.com`。

默认事件保持克制：`review.blocked`、`review.failed`、`service.degraded`。需要审计群时显式增加 `review.completed`。

## 卡片

卡片完全由本地确定性 formatter 生成，只使用已验证 Review Data，包括 Verdict、MR、短 HEAD、Severity 数量、耗时、最多 `topFindings` 条 Finding 和 MR 链接。不会推送 raw diff、Prompt、Secret、完整 Receipt，也不会让 AI 自由生成卡片文案。

## 重试与 Dead Letter

仅网络错误、HTTP 408/409/425/429 与 5xx 自动重试。Provider/配置永久错误进入 `notification_outbox.status=failed`，Prometheus Metrics 暴露通知 Queue 与终态。
