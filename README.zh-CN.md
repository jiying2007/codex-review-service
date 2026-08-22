# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

面向 GitLab Self-Managed Merge Request 的生产级、自托管 Codex 代码审核服务。v1.2 保留 v1.1 的可靠性与安全内核，但把部署和多仓库管理显著简化。

## Standard Deployment：默认部署

默认生产路径就是：**1 个 `codex-review-service` 进程 + 1 个结构化配置文件 + 受保护环境文件中的 GitLab Secret**。Codex 直接由服务账号调用。

```text
GitLab → codex-review-service
            ├─ SQLite WAL + synchronous=FULL
            ├─ Review Workers
            ├─ Publication Outbox / Publisher Workers
            └─ Codex CLI（Inline）
```

从 `config.example.json` 创建 `/etc/codex-review/config.json`：

```json
{
  "gitlab": {
    "baseUrl": "https://gitlab.example.internal",
    "projects": [101, 102],
    "groups": [
      { "id": 20, "includeSubgroups": true }
    ]
  },
  "review": { "concurrency": 2 },
  "runner": { "mode": "inline" }
}
```

`gitlab.projects` 与 Group 自动发现出来的项目会合并去重。Group 展开直接使用 GitLab 分页的 Group Projects API；默认排除 archived 项目，只纳入启用 Merge Request 的项目。发现过程 fail-closed：如果分页不完整或 API 失败，不会拿“不完整的新集合”覆盖上一次完整 scope，同时 readiness 会变为不健康。

Secret 保留在 `/etc/codex-review-service.env`：

```text
GITLAB_API_TOKEN=...
GITLAB_WEBHOOK_SIGNING_TOKEN=whsec_...
```

安装启动：

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo mkdir -p /etc/codex-review /opt/codex-review-service

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

正式运行 Doctor 或启动生产服务前修改上述两个配置文件。`config.json` 放非敏感产品配置，环境文件只放 Secret 和少量特殊覆盖项。`0640 root:codex-review` 让 Doctor 可以在真实服务用户下加载同一份 Secret，不需要把 Token 写进命令行。

## 多仓库监控与并发处理

一个 Review Service 原生支持同时监控多个仓库：

```json
{
  "gitlab": {
    "projects": [101, 102, 103],
    "groups": [
      { "id": 20, "includeSubgroups": true },
      { "id": 35, "includeSubgroups": false }
    ]
  }
}
```

不同仓库、不同 MR 可以并行处理，并发上限由 `review.concurrency` 控制；同一个 MR 始终严格串行。显式 Project ID 与 Group 自动发现结果共同组成运行时 allowlist，同时用于 Webhook 接收范围和周期 reconciliation。

旧部署仍可使用 `GITLAB_PROJECT_ALLOWLIST`。只要该环境变量存在，就明确覆盖 `config.json` 中的 `gitlab.projects/groups`；`GITLAB_PROJECT_ALLOWLIST=*` 继续保持 webhook-only，不做全量 reconciliation。

## Hardened Deployment：增强安全模式

高安全场景可以改成：

```json
{
  "runner": {
    "mode": "isolated",
    "socket": "/run/codex-review-runner/runner.sock"
  }
}
```

再启用可选的 `codex-review-runner.service`。Controller 只持有 GitLab 凭据和 SQLite，Runner 只持有 Codex/OpenAI 凭据，通过本机 Unix Socket 通信。它是纵深防御增强模式，**不是普通生产部署的前置要求**。

## 长期资产保证

- Webhook ACK 由 SQLite `WAL + synchronous=FULL` 的持久事务支撑。
- Review 与 GitLab Publication 通过事务性 Outbox 分离，发布失败不会重新消耗一次 Codex Review。
- 审核固定绑定目标 `start_sha` + 源 `head_sha`，stale 结果不能发布。
- External Status 绑定正确源项目/ref，并在可用时精确绑定 `pipeline_id`。
- 同 MR 严格串行，不同 MR 可并行。
- GitLab API 有全局限速、`Retry-After` 和 Circuit Breaker。
- Finding 必须精确命中 changed line，不做静默行号吸附。
- Finding identity 使用稳定代码 anchor。
- 真正 provider/local coverage gap fail-closed；metadata-only/generated/已知 binary 单独分类。
- Controller 只读取 immutable SHA 上的有界上下文，不 clone、不执行被审核代码。
- 目标分支确定性规则与 AI finding 共用同一 Gate/Outbox 生命周期。
- Codex Token usage 持久化，可配置 MR/项目预算。
- GitHub Actions 依赖固定 full commit SHA。

## GitLab Webhook

Webhook 地址：

```text
https://review.example.internal/webhooks/gitlab
```

开启 **Merge request events** 和 **Note events**。GitLab 19+ 推荐 Standard Webhooks Signing Token。手工 `/codex review` 默认要求 Developer 权限。

## 仓库审核策略

仓库可在目标分支提交 `.codex-review.json`，服务固定从 `diff_refs.start_sha` 读取，而不是从未审核的 source branch 读取。示例见 `.codex-review.example.json`。

仓库策略只能收紧资源上限或增加确定性规则，不能削弱全局 blocking threshold、confidence floor、Credential Boundary、Safe Contract 或服务并发边界。

## Health / Doctor

```text
GET /health/live
GET /health/ready
GET /metrics
```

Readiness 会同时检查 GitLab、SQLite durability、Review/Publisher Worker、Circuit Breaker 和 Project Scope 自动发现健康度。上面的 Doctor 命令会实际展开配置的 Group，并在正式接 Webhook 前输出最终 Project 数量。

更多见 [OPERATIONS.md](OPERATIONS.md)、[SECURITY.md](SECURITY.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[LONG_TERM_ASSET.md](LONG_TERM_ASSET.md)、[CHANGELOG.md](CHANGELOG.md)。

## 开发验证

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm pack --dry-run --ignore-scripts
```

CI 同时验证 Node.js 22.13.0 与 Node.js 24。
