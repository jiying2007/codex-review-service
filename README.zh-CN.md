# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

面向 GitLab Self-Managed Merge Request 的常驻、自托管 Codex 代码审核服务。

## 核心能力

- 接收 GitLab Merge Request / Note Webhook。
- MR open / update / reopen 自动审核。
- 支持在 MR 评论 `/codex review` 强制重审，即使 HEAD 未变化。
- SQLite WAL 持久化 Webhook、任务、审核运行和 findings。
- `webhook-id` 防重投，同一自动审核 HEAD 防重复执行。
- 新 HEAD 到来时 supersede/取消旧审核，并在发布前再次验证当前 HEAD。
- 服务重启后自动恢复中断任务，并对瞬态失败执行有上限重试。
- 使用 `GET /merge_requests/:iid/diffs`，不依赖已废弃的 `/changes` API。
- 对 finding 的文件和 post-change 行号做确定性校验，只允许落在本次变更附近。
- MR 总结评论使用 marker 做 upsert，不重复刷屏。
- finding 使用稳定 fingerprint；跨 HEAD 复用已有 discussion，问题消失后可自动 resolve。
- 写入 GitLab external commit status，可作为 Merge Gate。
- diff 被 GitLab 截断、`too_large`、`collapsed` 或超过本地预算时判定 `incomplete`，绝不误报 Pass。
- 服务启动前预检 Codex CLI 版本和所需安全参数能力。
- Codex 在临时空目录、read-only sandbox 中运行，子进程环境不会包含 GitLab API Token/Webhook Secret。

## 架构

```text
GitLab Self-Managed
      │
      │ Merge Request / Note Webhook
      ▼
Codex Review Service
      │
      ├─ Webhook 验签 + replay window
      ├─ Event Router
      ├─ SQLite Persistent Queue + Idempotency
      ├─ Stale Review Cancellation
      ├─ GitLab MR Snapshot / Diff Adapter
      ├─ Codex Structured Review
      ├─ Deterministic Finding Validation / Policy
      └─ GitLab Publisher
             ├─ Summary Note
             ├─ Inline Discussions
             └─ External Commit Status
```

## 环境要求

- Node.js 22.13+
- 服务账号可执行 OpenAI Codex CLI
- 服务主机可以访问局域网 GitLab
- GitLab Project/Group Access Token，具备读取 MR/diff 和写入 note/discussion/commit status 所需 API 权限
- GitLab 19+ 推荐 Signing Token；老版本可用 Secret Token

## 安装

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo mkdir -p /opt/codex-review-service /var/lib/codex-review /home/codex-review/.codex
sudo chown -R codex-review:codex-review /var/lib/codex-review /home/codex-review/.codex

git clone https://github.com/jiying2007/codex-review-service.git /opt/codex-review-service
cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund
```

使用 ChatGPT/Codex 登录时：

```bash
sudo -u codex-review -H codex login
```

也可以在受保护的环境文件中配置 `OPENAI_API_KEY`。

复制配置和 systemd unit：

```bash
sudo install -m 0600 .env.example /etc/codex-review-service.env
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/codex-review-service.service
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
```

## GitLab Webhook

项目或 Group Webhook 地址：

```text
https://review.example.internal/webhooks/gitlab
```

开启：

- Merge request events
- Note events

GitLab 19+ 建议 Generate signing token，然后把同一个 `whsec_...` 配置到：

```text
GITLAB_WEBHOOK_SIGNING_TOKEN
```

旧 GitLab 或迁移阶段可配置：

```text
GITLAB_WEBHOOK_SECRET_TOKEN
```

服务支持两者并存：请求带新版签名时优先 HMAC 验签，没有签名时才回退 Secret Token。

## Merge Gate

External Commit Status 状态：

- 审核中：`running`
- `pass` / `needs_attention`：`success`
- `block` / `incomplete` / 服务失败：`failed`

默认策略：

- `critical` / `high` → 阻断
- `medium` / `low` / `info` → 提醒
- coverage incomplete → 阻断

GitLab 开启 **Pipelines must succeed** 后，可把该 external status 纳入合并门禁。

## 安全边界

GitLab API Token 只属于 Review Service Controller。Codex 子进程采用环境白名单，仅保留基础运行变量、`CODEX_HOME` 和可选 `OPENAI_API_KEY`，不会继承 GitLab API Token、Webhook Signing Token、Secret Token 等服务秘密。

MR 标题、描述、diff、文件名和源码文本全部视为不可信数据。Codex 只接收有大小上限的文本 diff，在新的临时空目录使用 `--sandbox read-only` 运行，不需要 checkout 被审核仓库。systemd 只允许写入服务数据目录以及专用 Codex Auth 目录；后者用于 managed auth token 刷新。

完整说明见 [SECURITY.md](SECURITY.md)。

## 健康检查

```text
GET /health/live
GET /health/ready
GET /metrics
```

服务在监听端口前会完成 Codex CLI capability preflight；之后 `/health/ready` 检查 GitLab 可达性、worker 状态和队列深度，`/metrics` 输出 Prometheus 文本格式的 queue depth。

## 配置

完整示例见 [.env.example](.env.example)。常用策略项：

- `MAX_DIFF_BYTES`
- `MAX_FINDINGS`
- `MIN_CONFIDENCE`
- `REVIEW_TIMEOUT_SECONDS`
- `MAX_JOB_ATTEMPTS`
- `AUTO_RESOLVE_OBSOLETE`
- `TRIGGER_ON_OPEN`
- `TRIGGER_ON_PUSH`
- `TRIGGER_ON_REOPEN`

## 开发验证

```bash
npm ci
npm run ci
```

GitHub Actions 同时验证 Node.js 22 / 24。
