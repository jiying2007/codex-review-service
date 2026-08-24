# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

面向 **GitLab Self-Managed Merge Request** 的生产级、自托管 Codex 审查执行服务。一个 Service 实例可以同时管理多个 Project 和/或整个 Group。

## 快速开始

适合需要服务端 MR Review、与开发者工作站解耦、并把确定性状态/Discussion 发布回 GitLab 的场景。

推荐第一次部署使用：

> **systemd + inline Runner + 单机本地 SQLite**

只有明确要求 GitLab 凭据与 Codex/OpenAI 凭据分离到不同 Unix 用户/进程时，才使用 isolated Runner。

环境要求：

- Node.js 22.13+
- GitLab Self-Managed 19.1+
- GitLab Standard Webhooks Signing Token
- 最小权限 GitLab API Token
- Service 用户完成 OpenAI Codex CLI 登录，或配置 `OPENAI_API_KEY`

完整生产部署见 [部署指南](docs/DEPLOYMENT.zh-CN.md)。

## 5 分钟部署路径

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo mkdir -p /etc/codex-review

git clone --branch v4.0.4 --recurse-submodules \
  https://github.com/jiying2007/codex-review-service.git \
  /opt/codex-review-service
cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund
npm run core:init

sudo install -m 0644 deploy/systemd/config.example.json /etc/codex-review/config.json
sudo install -o root -g codex-review -m 0640 .env.example /etc/codex-review-service.env
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/
```

第一次只需要先改 4 类内容：

1. `gitlab.baseUrl`；
2. `gitlab.projects` 和/或 `gitlab.groups`；
3. `GITLAB_API_TOKEN`；
4. `GITLAB_WEBHOOK_SIGNING_TOKEN`。

先登录 Codex、跑 Doctor，再启动：

```bash
sudo -u codex-review -H codex login
sudo -u codex-review /usr/bin/node \
  --env-file=/etc/codex-review-service.env \
  src/doctor.js

sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
```

**Doctor 和 readiness 未通过前不要开启 GitLab Webhook。**

## 接入 GitLab

通过可信 HTTPS Ingress/Nginx 暴露：

```text
https://<review-host>/webhooks/gitlab
```

GitLab 19.1+ Webhook 开启：

- Merge request events
- Note events

Signing Token 与 `GITLAB_WEBHOOK_SIGNING_TOKEN` 使用同一个 Standard Webhooks Signing Token。

## 多仓库 Scope

一个实例可以指定多个 Project：

```json
"projects": [101, 102, 103],
"groups": []
```

也可以管理整个 Group：

```json
"projects": [],
"groups": [{ "id": 20, "includeSubgroups": true }]
```

也可以混用。Group discovery 支持分页并 fail closed；发现不完整时不会用残缺 Scope 覆盖上一次完整集合。

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
SQLite Review Receipt + Publication Outbox
          ↓
GitLab Status / Summary / Discussions
```

服务端 Review 不要求每个开发者安装插件。

## 配置边界

systemd 生产部署：

```text
/etc/codex-review/config.json      非 Secret 产品配置
/etc/codex-review-service.env      只放 Secret
/var/lib/codex-review              SQLite / State
```

普通用户直接运行则使用 XDG config/state 默认值。始终只有一套 JSON Schema，不通过 root/sudo/systemd 检测切换语义。

进程只接受：

```text
CODEX_REVIEW_CONFIG_FILE
GITLAB_API_TOKEN
GITLAB_WEBHOOK_SIGNING_TOKEN
OPENAI_API_KEY
```

## Repository Policy

被审查仓库可在目标分支提交 `.codex-safe.json` Policy Schema v3。Repository Policy 可以收紧 Limits 或增强 Rules，但不能削弱 Service 全局 Security、Blocking/Confidence 或 Capacity 边界。

## 运维

健康接口：

```text
GET /health/live
GET /health/ready
GET /metrics
```

首次上线以及重要配置/认证变更后都应运行 `npm run doctor`。

- 完整部署：[docs/DEPLOYMENT.zh-CN.md](docs/DEPLOYMENT.zh-CN.md)
- 运维/升级/备份/故障：[OPERATIONS.md](OPERATIONS.md)
- Support Checklist：[SUPPORT.md](SUPPORT.md)
- 安全：[SECURITY.md](SECURITY.md)
- 架构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Release 验证：[VERIFY_RELEASE.md](VERIFY_RELEASE.md)

## Hardened isolated Runner

需要凭据隔离时配置：

```json
"runner": {
  "mode": "isolated",
  "socket": "/run/codex-review-runner/runner.sock"
}
```

并使用独立 `codex-review-runner` 用户部署 `codex-review-runner.service`。除非有明确隔离要求，否则推荐保持 inline。

## 开发

```bash
git submodule update --init --recursive
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm pack --dry-run --ignore-scripts
```

## License

MIT
