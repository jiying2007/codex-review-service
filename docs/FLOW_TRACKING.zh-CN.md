# GitLab 流程跟踪

GitLab Flow Tracking 是 Codex Review Service 内一个默认关闭的确定性事件域，用于观察选定的 GitLab CI/CD 生命周期转换，并复用现有 durable notification outbox 投递通知。**该路径绝不调用 Codex，模型 Token 消耗为 0。**

## 产品边界

Flow Tracking 不是通用 GitLab 运维机器人。正式支持 Pipeline 终态、Merge Request 生命周期、Tag 创建/删除、Branch 创建/删除；Issue、Wiki、用户/Group 管理和任意 System Hook 继续明确不属于 Review Service。

## 配置

Config Schema 4 新增 `flowTracking`。`enabled` 默认 `false`，升级后不会自动产生新通知。开启但省略子项时采用克制默认值：Pipeline 仅 `failed`、MR 仅 `merge`、Tag 仅 `v*` 的 `create`，Branch Tracking 默认关闭。Pipeline ref/source/job name 可通过锚定的 `*`/`?` glob 过滤；Job 明细支持 `none`、`failed-only`、`all`。

`flowTracking` 决定跟踪哪些 GitLab 流程；`notifications.routes[].events` 独立决定哪些标准化终态事件进入哪个飞书/企业微信 Route，两层正交。

可路由事件：

- `gitlab.pipeline.succeeded` / `failed` / `canceled` / `skipped`
- `gitlab.mr.opened` / `merged` / `closed`
- `gitlab.tag.created` / `deleted`
- `gitlab.branch.created` / `deleted`

## 状态转换语义

每个已认证的 Flow 更新都会按 `(project_id, flow_type, external_id)` 投影到 SQLite `flow_state`。相同状态重复到达不会通知；真实状态转换才递增 revision，并把 revision 纳入 notification dedupe key。因此 `failed -> running -> failed` 的第二次失败会产生新的合法事件，而重复 Webhook 保持幂等。

Pipeline 的非终态可以更新状态投影但不通知。终态卡片只包含 Pipeline/ref/status/source/duration 与经过配置过滤的 Job 摘要；不会发送 raw log、artifact、diff、Prompt、Secret 或完整 Receipt。

## GitLab Hook

Review 继续开启 Merge Request + Note events。使用 Pipeline Tracking 时额外开启 Pipeline events；Tag Tracking 开启 Tag Push events；Branch 创建/删除跟踪开启 Push events。所有事件继续复用同一 Classic Token（<19.1）或 Standard HMAC（>=19.1）认证入口以及 Project/Group allowlist。
