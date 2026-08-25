# 生产部署指南

## 支持基线

部署前先读取 `product-contract.json`。Codex Review Service 5.0.0 要求：Node.js >=24.19.0 <25、GitLab Self-Managed >=19.1.0、Database Schema 5、Config Schema 1。

Safe Core 保持 exact commit pin，不要在正式 Release 中替换 gitlink 或复制其他 Core 版本。

## 选择部署模式

### 标准 systemd / inline Runner

默认推荐。Controller、SQLite、GitLab Provider 与 Codex 执行运行在同一个 Unix Service User 下。

### Hardened systemd / isolated Runner

只有在必须把 GitLab 凭据与 OpenAI/Codex 凭据拆分到不同 Unix 用户/进程时使用。Controller 持有 GitLab/state；Runner 只持有 Codex/OpenAI 凭据，并通过 Unix Socket 暴露 Safe Contract。

### Docker / Compose

使用 Release 发布的 `compose.release.yaml` 与 canonical GHCR digest。生产主机不要重新 build 源码。

## 安装已验证 Release

先按 `VERIFY_RELEASE.md` 验证 checksum 与 provenance。systemd 可把已验证 tgz 解压到 `/opt/codex-review-service`。

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo install -d -o root -g codex-review -m 0750 /etc/codex-review/secrets
sudo install -d -o codex-review -g codex-review -m 0700 /var/lib/codex-review
sudo install -m 0644 deploy/systemd/config.example.json /etc/codex-review/config.json
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/
```

每个 Controller Secret 文件使用 `root:codex-review`、`0640`。isolated 模式下，OpenAI Secret 应只授权 Runner 用户/组，并安装 `codex-review-runner.service` 与对应 env example。

## 配置 Config Schema 1

配置文件必须显式包含：

```json
{
  "schemaVersion": 1,
  "server": { "host": "127.0.0.1", "port": 8787, "dataDir": "/var/lib/codex-review" },
  "gitlab": {
    "baseUrl": "https://gitlab.example.internal",
    "projects": [101, 102],
    "groups": [{ "id": 20, "includeSubgroups": true }]
  }
}
```

至少配置一个 Project 或 Group。未知字段和不支持的 Config Schema 版本 fail closed。

## 配置 Secret

生产环境优先使用受保护文件与 `_FILE`：

```text
GITLAB_API_TOKEN_FILE=/etc/codex-review/secrets/gitlab-api-token
GITLAB_WEBHOOK_SIGNING_TOKEN_FILE=/etc/codex-review/secrets/gitlab-webhook-signing-token
OPENAI_API_KEY_FILE=/etc/codex-review/secrets/openai-api-key       # inline 模式可选
```

`GITLAB_API_TOKEN` / `GITLAB_WEBHOOK_SIGNING_TOKEN` 直接值仍可用于合适场景，但不能和对应 `_FILE` 同时存在。

GitLab API Token 应限制在配置的 Projects/Groups，只授予读取 MR/仓库、写 notes/discussions/status 所需权限。Secret 轮换流程：原子替换受保护文件 → Doctor → 重启对应进程。

## Codex 认证

可直接以执行用户登录：

```bash
sudo -u codex-review -H codex login
```

或提供 `OPENAI_API_KEY_FILE`。isolated 模式下该凭据只属于 Runner。

## Doctor 预检

```bash
cd /opt/codex-review-service
sudo -u codex-review /usr/bin/node \
  --env-file=/etc/codex-review-service.env \
  src/doctor.js
```

Doctor 会检查 product/config identity、SQLite Schema 5 与完整性、Codex capability contract、GitLab 连接/版本及完整 Project/Group scope。

## 启动 systemd

标准模式：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
```

isolated：

```bash
sudo systemctl enable --now codex-review-runner
sudo systemctl enable --now codex-review-service
```

检查：

```bash
curl -fsS http://127.0.0.1:8787/health/live
curl -fsS http://127.0.0.1:8787/health/ready
curl -fsS http://127.0.0.1:8787/health/dependencies
curl -fsS http://127.0.0.1:8787/version
curl -fsS http://127.0.0.1:8787/metrics | head
```

`/health/ready` 表示 durable Webhook intake 是否安全；`/health/dependencies` 单独表示 GitLab/scope 依赖健康。

## 配置 GitLab Webhook

通过可信 HTTPS ingress 暴露：

```text
https://<review-host>/webhooks/gitlab
```

GitLab Webhook 使用 Standard Webhooks Signing Token，并启用：

- **Merge request events**
- **Note events**

Signing Token 必须与 `GITLAB_WEBHOOK_SIGNING_TOKEN` / `_FILE` 一致。Doctor 和 `/health/ready` 未通过前不要启用 Webhook。

## 端到端验收

使用可丢弃测试 MR：

1. Open/update MR。
2. 确认 Webhook 快速返回，只把工作持久化入队。
3. 观察 GitLab `running` → terminal status。
4. 同一 immutable snapshot 只有一个 durable Review Run。
5. summary/discussions 通过 `publication_outbox` 收敛。
6. 开启通知时，飞书/企业微信通过 `notification_outbox` 收到确定性 Card。
7. Push 新 commit，旧 snapshot 被 supersede，旧 publication 不会覆盖新状态。
8. 重发 duplicate webhook，确认幂等，不产生重复 Review。
9. 保存 `/version` 作为部署证据。

## Docker / Compose

使用 Release 中：

```text
IMAGE_DIGEST.txt
compose.release.yaml
```

准备 Secret：

```bash
mkdir -p secrets
chmod 0700 secrets
printf '%s' "$GITLAB_API_TOKEN" > secrets/gitlab_api_token
printf '%s' "$GITLAB_WEBHOOK_SIGNING_TOKEN" > secrets/gitlab_webhook_signing_token
chmod 0600 secrets/*
```

启动：

```bash
docker compose -f compose.release.yaml up -d
curl -fsS http://127.0.0.1:8787/health/ready
```

Compose 将 Secret 映射到 `/run/secrets/*`，必需凭据不再依赖 `env_file`。OpenAI/Notification Secret 可按同一 `_FILE` 契约扩展。

## Reverse Proxy

在可信 ingress/reverse proxy 终止 TLS。必须保留原始 request body 和 Standard Webhooks 签名 Header，不能改写已签名 payload bytes。网络策略允许时限制管理 endpoint 的直接访问。

## Upgrade 前备份

```bash
npm run admin -- backup /secure-backup/pre-upgrade.sqlite
npm run admin -- backup-verify /secure-backup/pre-upgrade.sqlite
npm run admin -- drain 120
```

## Upgrade

从 v5.0.0 起，已发布 DB/Config 兼容性是正式产品契约。任何后续 Schema 转换都必须有显式 migration 与测试。

1. 阅读 Release Notes / rollback boundary。
2. 创建并验证备份。
3. Drain durable work。
4. 验证新 tgz/OCI digest 与 provenance。
5. 安装/切换到精确 Release。
6. Doctor。
7. 重启 Service/Runner。
8. 检查 `/health/ready`、`/version` 与 queue/outbox 状态。

## Rollback

只有 Release 声明的 Schema boundary 内允许回滚。绝不能让旧 binary 直接读取一个更高且不可逆的新 DB/Config Schema。

若 rollback compatible：

1. Stop Controller。
2. 恢复上一版已验证 binary/image。
3. 如边界要求，恢复 upgrade 前数据库。
4. 恢复匹配的 Config Schema 文件。
5. Doctor。
6. 启动并验证 `/health/ready`、`/health/dependencies`、`/version`。

## 生产渐进放量

大范围 Group/Project 建议先用少量显式 Project，观察 queue age、Token、Review/Publication latency，再逐步扩大 scope。一个实例只覆盖一个管理/安全信任域；不同保密级别或凭据域使用独立实例。

更多 Admin CLI、Backup/Restore、Incident、SLO/Capacity 与 fatal crash/restart 语义见 `OPERATIONS.md`。
