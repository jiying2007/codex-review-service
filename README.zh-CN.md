# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

面向 GitLab Self-Managed Merge Request 的生产级、自托管 Codex 代码审核服务。**v2.0 删除全部 v1 兼容路径**，正式收敛为：单一非 Secret 配置文件、GitLab Signed Webhook、显式 Projects/Groups 范围、SQLite/Outbox 持久语义，以及可选的独立 Codex Runner 安全加固。

## 环境要求

- Node.js **22.13+**
- GitLab Self-Managed **19.1+**，配置 Standard Webhooks Signing Token
- GitLab API Token，只授予配置范围内所需的 Project/Group/MR/Repository/Discussion/Status 权限
- Standard 模式由服务用户登录 Codex CLI；Hardened 模式由独立 Runner 用户登录

## 配置契约

所有非敏感产品配置只有一个来源：

```text
/etc/codex-review/config.json
```

从 [`config.example.json`](config.example.json) 复制并修改。环境变量只允许：

```text
CODEX_REVIEW_CONFIG_FILE      # 可选，自定义配置文件路径
GITLAB_API_TOKEN              # 必填 Secret
GITLAB_WEBHOOK_SIGNING_TOKEN  # 必填 Secret
OPENAI_API_KEY                # 可选 Codex 认证 Secret
```

Project Scope、Runner 模式、并发、预算、生命周期、可观测性、GitLab URL、审核上限等都不再支持环境变量覆盖，避免“文件里是 A、运行时实际是 B”的隐藏优先级。

## Standard Deployment：默认部署

默认生产路径就是一个进程直接调用 Codex：

```text
GitLab → codex-review-service
            ├─ SQLite WAL + synchronous=FULL
            ├─ Review Workers
            ├─ Publication Outbox / Publisher Workers
            └─ Codex CLI（Inline）
```

最简安装：

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo mkdir -p /etc/codex-review

git clone https://github.com/jiying2007/codex-review-service.git /opt/codex-review-service
cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund

sudo install -m 0644 config.example.json /etc/codex-review/config.json
sudo install -o root -g codex-review -m 0640 .env.example /etc/codex-review-service.env
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/

sudo -u codex-review -H codex login
sudo -u codex-review /usr/bin/node --env-file=/etc/codex-review-service.env src/doctor.js
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
```

正式运行 Doctor/服务前先修改 `config.json` 和 Secret 环境文件。

## 多仓库 Scope

一个 Review Service 可以同时管理多个 Project 与 Group：

```json
{
  "gitlab": {
    "baseUrl": "https://gitlab.example.internal",
    "projects": [101, 102, 103],
    "groups": [
      { "id": 20, "includeSubgroups": true },
      { "id": 35, "includeSubgroups": false }
    ]
  },
  "review": {
    "concurrency": 4
  },
  "runner": {
    "mode": "inline"
  }
}
```

Group Project 自动发现支持分页、去重、排除 archived Project；只有完整发现成功后才替换运行时 Scope。发现失败/分页不完整时继续保留上一次完整集合，同时 readiness 变为不健康。不同 MR 可以并行，同一个 MR 始终严格串行。

## Hardened Deployment：增强安全模式

配置：

```json
{
  "runner": {
    "mode": "isolated",
    "socket": "/run/codex-review-runner/runner.sock"
  }
}
```

启用 `codex-review-runner.service`。Controller 与 Runner 读取同一个 `config.json`；Controller 持有 GitLab 凭据和 SQLite，Runner 只持有 Codex/OpenAI 凭据，不持有 GitLab 凭据。

## GitLab Webhook

GitLab 19.1+ 配置 Signing Token，并启用 **Merge request events** 和 **Note events**：

```text
https://review.example.internal/webhooks/gitlab
```

服务强制校验 `webhook-id`、`webhook-timestamp`、`webhook-signature`、原始 Body HMAC、重放时间窗和 `X-Gitlab-Instance`。v2 不再支持纯文本 `X-Gitlab-Token`。

## 长期资产不变量

- Webhook 202 前先完成 SQLite `WAL + synchronous=FULL` 持久事务；
- Review 与 GitLab Publication 通过事务性 Outbox 分离；
- 审核固定绑定目标 `start_sha` + 源 `head_sha`；
- stale 结果、移出 Scope 的旧 Publication 都不能继续写 GitLab；
- External Status 绑定正确 source project/ref，并尽量绑定精确 `pipeline_id`；
- Finding 必须精确命中 changed line，不做 ±N 行修复；
- Finding identity 使用稳定代码 anchor；
- 真实 provider/local coverage gap fail-closed；
- Controller 只读取 immutable SHA 上的有界上下文，不 clone、不执行被审核代码；
- 目标分支确定性规则与 AI Finding 共用同一 Gate/Outbox；
- Codex Token usage、MR/Project Budget 持久化并执行；
- GitLab API 有限速、Retry-After 和 Circuit Breaker；
- GitHub Actions 依赖人工审查并固定 immutable full SHA。

## 仓库审核策略

仓库可在目标分支提交 `.codex-review.json`，服务只从 `diff_refs.start_sha` 读取。参考 [`.codex-review.example.json`](.codex-review.example.json)。仓库策略只能收紧上限或增加确定性规则，不能削弱全局 Gate、Confidence、Credential Boundary、Safe Contract 或服务容量边界。

## Health / Doctor

```text
GET /health/live
GET /health/ready
GET /metrics
```

`npm run doctor` 会验证配置、SQLite durability/schema、Codex/Runner capability、GitLab 可达性和完整 Projects/Groups Scope，不执行真实代码审核。

更多见 [OPERATIONS.md](OPERATIONS.md)、[SECURITY.md](SECURITY.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[LONG_TERM_ASSET.md](LONG_TERM_ASSET.md)、[CHANGELOG.md](CHANGELOG.md)。

## v1.x → v2.0 迁移

把所有非 Secret 环境配置迁入 `/etc/codex-review/config.json`。删除 `GITLAB_PROJECT_ALLOWLIST`、`GITLAB_WEBHOOK_SECRET_TOKEN`、`CODEX_RUNNER_MODE`、`CODEX_RUNNER_SOCKET`、`GITLAB_BASE_URL`、各类并发/预算/生命周期/OTLP 环境覆盖；在 GitLab 配置 Signing Token，环境文件只保留 v2 支持的 Secret。重新接 Webhook 前先跑 Doctor。

## 开发验证

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm pack --dry-run --ignore-scripts
```

CI 同时验证 Node.js 22.13.0 与 Node.js 24。
