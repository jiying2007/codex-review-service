# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

面向 **GitLab Self-Managed Merge Request** 的生产级、自托管 Codex 审查执行服务。一个 Service 实例可以同时管理多个 Project / Group，并可选把确定性 Review 卡片路由到飞书/Lark或企业微信。

## 快速开始

适合需要服务端 MR Review、与开发者工作站解耦、并把确定性状态/Discussion 发布回 GitLab 的场景。

推荐生产部署：

> **systemd + inline Runner + 单机本地 SQLite**

如果希望快速容器化落地，也提供一等支持的 rootless Docker/Compose。只有明确要求 GitLab 凭据与 Codex/OpenAI 凭据分离到不同 Unix 用户/进程时，才使用 isolated Runner。

环境要求：

- Node.js 22.13+
- GitLab Self-Managed 19.1+
- GitLab Standard Webhooks Signing Token
- 最小权限 GitLab API Token
- Service 用户完成 OpenAI Codex CLI 登录，或配置 `OPENAI_API_KEY`

完整生产部署见 [部署指南](docs/DEPLOYMENT.zh-CN.md)，GitLab UI 接入见 [GitLab 接入](docs/GITLAB_SETUP.zh-CN.md)。

## 5 分钟 systemd 部署

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo mkdir -p /etc/codex-review

git clone --branch v4.1.0 --recurse-submodules \
  https://github.com/jiying2007/codex-review-service.git \
  /opt/codex-review-service
cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund
npm run core:init

sudo install -m 0644 deploy/systemd/config.example.json /etc/codex-review/config.json
sudo install -o root -g codex-review -m 0640 .env.example /etc/codex-review-service.env
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/
```

先配置 `gitlab.baseUrl`、`gitlab.projects` 和/或 `gitlab.groups`、`GITLAB_API_TOKEN`、`GITLAB_WEBHOOK_SIGNING_TOKEN`，再登录 Codex、跑 Doctor：

```bash
sudo -u codex-review -H codex login
sudo -u codex-review /usr/bin/node --env-file=/etc/codex-review-service.env src/doctor.js
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
```

**Doctor 和 readiness 未通过前不要开启 GitLab Webhook。**

## Docker / Compose

```bash
cp config.example.json deploy/docker/config.json
cp .env.example deploy/docker/.env
# 将 deploy/docker/config.json 中 server.host 设为 0.0.0.0，server.dataDir 设为 /var/lib/codex-review。
docker compose -f deploy/docker/compose.yaml up -d --build
curl -fsS http://127.0.0.1:8787/health/ready
```

镜像使用非 root 用户、丢弃 Linux capabilities、read-only rootfs，只持久化 Service State/Codex Home；默认 pin Codex CLI 镜像依赖，但启动时仍执行 Safe Contract capability probe。详见 [Docker 部署](deploy/docker/README.md)。

## 接入 GitLab

通过可信 HTTPS Ingress/Nginx 暴露：

```text
https://<review-host>/webhooks/gitlab
```

GitLab 19.1+ Webhook 开启 **Merge request events** 与 **Note events**，Signing Token 与 `GITLAB_WEBHOOK_SIGNING_TOKEN` 使用同一个 Standard Webhooks Signing Token。

## 多仓库 Scope

一个实例可管理多个 Project、Group 层级或两者混用。Group discovery 支持分页并 fail closed；发现不完整时不会用残缺 Scope 覆盖上一次完整集合。

```json
"projects": [101, 102, 103],
"groups": [{ "id": 20, "includeSubgroups": true }]
```

## IM 通知

飞书/Lark 与企业微信 Route 使用**独立 durable notification outbox**，支持确定性卡片、幂等、受控重试、重启恢复、failed 终态与 Prometheus Metrics。

```json
"notifications": {
  "enabled": true,
  "events": ["review.blocked", "review.failed", "service.degraded"],
  "routes": [
    {
      "name": "embedded-review",
      "provider": "feishu",
      "secretRef": "embedded",
      "projects": [101, 102],
      "groups": [],
      "events": ["review.blocked", "review.failed"]
    }
  ]
}
```

`secretRef: "embedded"` 只从 `CODEX_REVIEW_NOTIFY_EMBEDDED_WEBHOOK` 解析。Webhook Secret 不进入 JSON 或 SQLite。通知失败**绝不改变 Review Verdict，也绝不重新运行 Codex**。为避免刷群，默认不推送成功消息；审计群可显式增加 `review.completed`。详见 [IM 通知](docs/NOTIFICATIONS.zh-CN.md)。

## 开发者如何使用

```text
开发者创建/更新 GitLab MR
          ↓
GitLab Signed Webhook
          ↓
Codex Review Service Queue
          ↓
Immutable MR Evidence + target .codex-safe.json
          ↓
Deterministic Rules + Codex Review
          ↓
SQLite Review Receipt + GitLab Publication Outbox + Notification Outbox
          ├─ GitLab Status / Summary / Discussions
          └─ 可选飞书 / 企业微信确定性卡片
```

服务端 Review 不要求每个开发者安装插件。GitLab 是 Review System of Record，SQLite 是 Service Durable Source of Truth，IM 只负责 Attention Routing。

## 配置边界

systemd 生产部署：

```text
/etc/codex-review/config.json      非 Secret 产品配置
/etc/codex-review-service.env      只放 Secret
/var/lib/codex-review              SQLite / State
```

普通用户直接运行使用 XDG config/state 默认值。始终只有一套 closed JSON Schema，不通过 root/sudo/systemd 检测切换语义。

支持的 Secret/进程输入：

```text
CODEX_REVIEW_CONFIG_FILE
GITLAB_API_TOKEN
GITLAB_WEBHOOK_SIGNING_TOKEN
OPENAI_API_KEY
CODEX_REVIEW_NOTIFY_<SECRET_REF>_WEBHOOK   # 仅配置 IM Route 后使用
```

## Repository Policy

被审查仓库可在目标分支提交 `.codex-safe.json` Policy Schema v3。Repository Policy 可以收紧 Limits 或增强 Rules，但不能削弱 Service 全局 Security、Blocking/Confidence 或 Capacity 边界。

## 运维

```text
GET /health/live
GET /health/ready
GET /metrics
```

首次上线以及重要配置/认证变更后都应运行 `npm run doctor`。

- 完整部署：[docs/DEPLOYMENT.zh-CN.md](docs/DEPLOYMENT.zh-CN.md)
- GitLab 接入：[docs/GITLAB_SETUP.zh-CN.md](docs/GITLAB_SETUP.zh-CN.md)
- IM 通知：[docs/NOTIFICATIONS.zh-CN.md](docs/NOTIFICATIONS.zh-CN.md)
- Docker：[deploy/docker/README.md](deploy/docker/README.md)
- 运维/升级/备份/故障：[OPERATIONS.md](OPERATIONS.md)
- Support Checklist：[SUPPORT.md](SUPPORT.md)
- 安全：[SECURITY.md](SECURITY.md)
- 架构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Release 验证：[VERIFY_RELEASE.md](VERIFY_RELEASE.md)

## Hardened isolated Runner

需要凭据隔离时配置 `runner.mode="isolated"`，并使用独立 `codex-review-runner` 用户部署 `codex-review-runner.service`。除非有明确隔离要求，否则推荐保持 inline。

## 开发

```bash
git submodule update --init --recursive
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm pack --dry-run --ignore-scripts
```

## License

MIT
