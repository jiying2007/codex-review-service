# IM 通知

Codex Review Service 支持把确定性 Review 卡片推送到飞书/Lark 与企业微信群机器人。IM 只负责吸引注意力：SQLite 仍是 Service durable source of truth，GitLab 仍是 Review system of record。

## 可靠性模型

Review 成功完成时，GitLab publication actions 与 notification actions 在同一个 SQLite transaction 中持久化；Review 最终失败时，failed job 状态与 `review.failed` notification actions 也在同一个 transaction 中持久化。`notification_outbox` 独立重试、独立幂等、支持重启恢复，并有独立 failed 终态；通知失败不会改变 Review Verdict，也绝不会重新运行 Codex。

## Route 与 Secret

在 Config Schema 6 中开启 `notifications.enabled` 并配置 routes。Route 可按明确 `projects`、GitLab `groups` 路由；两者都为空时表示当前 Service 已解析的全部 Project。每个 Route 指定 `feishu`、`feishu_app` 或 `wecom`、`secretRef` 与可选事件过滤。

`secretRef: "embedded"` 可从 `CODEX_REVIEW_NOTIFY_EMBEDDED_WEBHOOK` 读取；生产环境优先使用文件形式 `CODEX_REVIEW_NOTIFY_EMBEDDED_WEBHOOK_FILE`。直接值与 `_FILE` 不能同时设置。Webhook URL 不进入 JSON 或 SQLite。飞书只允许官方 `open.feishu.cn`/`open.larksuite.com` Bot URL；企业微信只允许 `qyapi.weixin.qq.com`。

飞书/Lark 签名 Secret 同样支持 `CODEX_REVIEW_NOTIFY_<REF>_SIGNING_SECRET` 或 `CODEX_REVIEW_NOTIFY_<REF>_SIGNING_SECRET_FILE`。Service 在真正投递时生成 timestamp + HMAC-SHA256 + Base64 签名，Secret 不持久化。Docker 生产环境应通过 Compose secrets 挂载到 `/run/secrets/*`；systemd 使用受权限保护的本地 Secret 文件。

`feishu_app` 是定向飞书应用机器人 Provider。它读取 `CODEX_REVIEW_NOTIFY_<REF>_APP_ID`、`CODEX_REVIEW_NOTIFY_<REF>_APP_SECRET`、`CODEX_REVIEW_NOTIFY_<REF>_CHAT_ID`（或彼此互斥的 `_FILE` 形式）；`CHAT_ID` 必须是 `oc_…` 群 ID。Service 获取并缓存 `tenant_access_token`，再调用 `POST /im/v1/messages?receive_id_type=chat_id`，发送与现有 Provider 相同的确定性 interactive card。凭证、tenant token 和 chat ID 均不会写入 `notification_outbox`。

默认事件保持克制：`review.blocked`、`review.failed`、`service.degraded`。需要审计群时显式增加 `review.completed`。

## 卡片

卡片完全由本地确定性 formatter 生成。飞书使用带状态色 Header 的 `interactive` card：MR 标题、结论、作者、短 HEAD、分支、问题数量以结构化字段展示，时间与耗时收敛到底部；只有阻断或失败场景才展开 Top Findings。企业微信使用 `text_notice` template card，并将 MR、结论、问题计数与耗时压缩为稳定字段，同时提供协议要求的 `card_action`。

MR Title、Branch、Finding Title/File、Error Code 和系统 Detail 在进入 durable notification event 之前完成控制字符与卡片/Markdown 元字符净化；MR URL 只接受不含凭据与 fragment 的 HTTP(S) 地址。

卡片只包含 Verdict、MR、短 HEAD、Severity 数量、耗时、最多 `topFindings` 条 Finding 与已有 MR 链接。不会推送 raw diff、Prompt、Secret、完整 Receipt，也不会让 AI 自由生成卡片文案。

GitLab Flow 卡片也使用事件专属字段，而非复用 Review 字段：Pipeline 展示编号、状态、Ref 与来源；MR 生命周期展示 MR、状态、分支与操作者；Push/Commit 展示分支、提交数、短 SHA 范围与推送者；Tag/Branch 展示对象、状态与操作者。Commit 明细仍按配置上限截断，避免高频 Push 造成卡片过长。

`feishu_app` Route 可设置 `statusCard: true`。Service 在 MR 校验后先通过 durable outbox 发送“审查中”卡片，并在 `review_status_cards` 中持久化 `job_id + route_name + message_id`；最终结果通过飞书 PATCH 更新同一条消息。重启会恢复 delivering outbox；若初始卡片终态失败，最终结果自动降级为一次性发送。群机器人 webhook 和企业微信保持一次性最终通知。

同一 App 的并发 Token 获取使用 single-flight，发送与 PATCH 默认按 20 RPS 节流；HTTP 429 `Retry-After` 和飞书 retry-after 字段会覆盖指数退避但仍受最大延迟上限约束。飞书卡片在序列化后执行 28,000-byte 安全门禁，超限时确定性降级为结论、截断说明和主跳转按钮。

Route 还支持 `branches`、`severities`、`authors`、`reviewers` 精确订阅，模式字段支持 `*`/`?`。`language` 可设为 `zh-CN` 或 `en`，`diagnosticsUrl` 会作为只读“服务诊断”按钮。没有飞书事件回调时，卡片不提供重试 Review、忽略 Finding 等写操作；失败通知仍由 Admin CLI 审计式重试。

## 责任人 @ 与私聊

`notifications.identities` 以 GitLab `gitlabUserId`（优先）或 `gitlabUsername` 精确映射到飞书 `feishuOpenId`；禁止按姓名猜测。`feishu_app` Route 可设置 `responsibility`：`order` 的默认优先级是 Reviewer → Assignee → Author，只有 `mentionEvents`、`mentionSeverities` 同时命中时才在最终群卡写入安全生成的 `@责任人`。`directMessage: true` 会对每位已映射责任人另投递一张终态只读私聊卡；它有独立 outbox 去重键，私聊失败不会影响群卡或 Review Verdict。

私聊使用 `receive_id_type=open_id`，因此飞书应用必须具有向目标用户发送消息的权限，且目标用户必须在应用可用范围内。群内同卡仍仅由 Route 的 `chat_id` 持久化和 PATCH 更新；私聊不创建“审查中”卡片，也不会争用群卡 `message_id`。身份映射不包含密钥，但属于组织用户标识，日志和诊断输出必须脱敏。

Notifier 的 `provider_accepted` 表示飞书 API 已接受请求并创建消息会话，不表示用户客户端已读或一定弹出系统通知；飞书客户端的会话可见性、免打扰和应用通知设置由用户/管理员控制。

`gitlab.push.committed` 默认等待 30 秒聚合窗口。同一 Project、Branch、Route 的 pending Push 合并为一张卡，累计 Commit 数量和 SHA 范围；正文只展开最多 3 条 Commit，其余显示数量。Schema 8 用生成列和复合索引保存聚合键、截止时间、操作类型与状态卡 Job ID，Notifier 不再全表解析 JSON。Pipeline 仅选择配置的终态并沿用 `flow_state` 状态去重。Push/Pipeline 只有在 Project、Source Branch、24 小时时效和可用 Head SHA 同时匹配已有 Review Job 时才关联 MR；无法可靠关联时保持独立。

每张 Review、Push、Pipeline、MR、Tag 与分支卡片都会显示“仓库”。Review 优先使用 GitLab `references.full` 中的 `group/project!IID` 路径，Flow 通知使用 webhook 的 `project.path_with_namespace`；缺失时隐藏字段，而不是以不稳定的 Project ID 伪装仓库名。

真实飞书验收默认使用 dry-run，不产生外部消息；只有显式 `--send` 才会创建并 PATCH 测试卡：

```bash
npm run admin -- smoke-feishu-card <feishu_app-route>
npm run admin -- smoke-feishu-card <feishu_app-route> --send
```

Doctor 会报告潜在重复 Route、不安全而被抑制的 `diagnosticsUrl`，以及带 Severity 过滤导致只能发送最终卡的状态卡 Route。

## 重试与 Terminal Failure

仅网络错误、HTTP 408/409/425/429、5xx 和被明确归类为瞬态的飞书 API code 自动重试。无效凭证、缺少机器人权限、非法 chat ID、卡片格式错误和其他 Provider/配置永久错误进入 `notification_outbox.status=failed`。缓存 token 被拒绝时，会先失效并刷新一次，再对该 outbox 尝试归类。Prometheus 暴露通知 Queue、oldest age、delivered/retry/failure、飞书 Token 刷新失败和每个受配置约束 Route 的 terminal failure counter；Webhook 鉴权拒绝继续使用既有 counter。

修复真实原因后，可以通过 Admin CLI 显式重试单个 terminal failed delivery；不会改变 Review Verdict，也不会重跑 Codex：

```bash
npm run admin -- notifications
npm run admin -- retry-notification <id>
```

事故处理不要删除 `notification_outbox` 行。

通知事件时间统一使用 canonical UTC ISO-8601。对于 Review 通知，卡片时间精确复用已持久化的 Review Receipt v4 `createdAt`，表示实际审查完成时间，而不是 notification outbox 延迟后的投递时间。
## GitLab Flow 事件

Config Schema 4 可以通过同一 durable outbox 路由确定性的 `gitlab.pipeline.*`、`gitlab.mr.*`、`gitlab.tag.*`、`gitlab.branch.*` 事件。事件采集由 `flowTracking` 控制，投递仍由 `notifications.routes[].events` 控制；Flow 卡片完全由本地 formatter 生成，Codex Token 消耗为 0。详见 `FLOW_TRACKING.zh-CN.md`。

## Commit Push 通知

`gitlab.push.committed` 是确定性的聚合通知，包含 Branch、Pusher、before/after 范围、Commit 总数和配置上限内的 Commit 摘要。该路径不会额外获取 GitLab diff，也绝不调用 Codex。
