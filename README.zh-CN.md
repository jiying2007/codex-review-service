# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

面向 **GitLab Self-Managed Merge Request** 的生产级、自托管 Codex Review 服务。**v5.0.0** 定义为生产运维完整基线：一个管理/安全信任域可覆盖多个显式 Project / Group，同时提供 durable GitLab Publication 与可选的飞书/Lark、企业微信确定性通知。

## 产品契约

`product-contract.json` 是唯一机器校验的产品事实源：

- Service：**5.0.0**
- Database Schema：**5**
- Config Schema：**1**
- Policy Schema：**3**
- Review Receipt：**4**
- Safe Contract：**2**
- Safe Core：精确提交 `7ffbf6f1791e17ba74faf0922e7a702bdac72059`
- Node.js：**>=24.19.0 <25**
- GitLab Self-Managed：**>=19.1.0**

当前 CI 还会对真实 GitLab CE 19.1.x 与当前认证版本线运行 Provider 契约。Safe Core 仍是 Family v4；Service v5 不改变共享 Review 协议。

## 适用场景

当你希望 MR Review 在服务器侧运行、独立于开发者工作站，并确定性发布 GitLab status / summary / discussions 时使用本产品。

推荐生产部署：

> **systemd + inline Runner + 单机本地 SQLite**

只有在必须把 GitLab 凭据与 Codex/OpenAI 凭据拆到不同 Unix 用户/进程时才使用 isolated Runner。Docker/Compose 同样是一等部署方式，但生产环境应消费 Release 发布的 **digest 固定 `compose.release.yaml` / GHCR 镜像**，不要在目标机器重新 build 源码。

## 5 分钟部署

优先把经过验证的 `codex-review-service-5.0.0.tgz` 安装到 `/opt/codex-review-service`；精确 Tag checkout 仅用于开发/审计。

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo install -d -o root -g codex-review -m 0750 /etc/codex-review/secrets
sudo install -m 0644 deploy/systemd/config.example.json /etc/codex-review/config.json
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/
```

每个 Secret 文件使用 `root:codex-review`、`0640`，再通过 `_FILE` 指向；直接值与 `_FILE` 二选一，同时存在会 fail closed：

```text
GITLAB_API_TOKEN_FILE=/etc/codex-review/secrets/gitlab-api-token
GITLAB_WEBHOOK_SIGNING_TOKEN_FILE=/etc/codex-review/secrets/gitlab-webhook-signing-token
OPENAI_API_KEY_FILE=/etc/codex-review/secrets/openai-api-key   # 可选
```

配置必须包含 `schemaVersion: 1`，并设置 `gitlab.baseUrl`、`gitlab.projects` 和/或 `gitlab.groups`。随后：

```bash
cd /opt/codex-review-service
sudo -u codex-review /usr/bin/node --env-file=/etc/codex-review-service.env src/doctor.js
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
curl -fsS http://127.0.0.1:8787/health/dependencies
curl -fsS http://127.0.0.1:8787/version
```

Doctor 和 `/health/ready` 通过之前不要启用 GitLab Webhook。

## Docker / Compose

正式 Release 会发布 canonical 多架构 GHCR 镜像、OCI SBOM/provenance 元数据、`IMAGE_DIGEST.txt` 与 digest 固定的 `compose.release.yaml`。

```bash
mkdir -p secrets
chmod 0700 secrets
printf '%s' "$GITLAB_API_TOKEN" > secrets/gitlab_api_token
printf '%s' "$GITLAB_WEBHOOK_SIGNING_TOKEN" > secrets/gitlab_webhook_signing_token
chmod 0600 secrets/*
docker compose -f compose.release.yaml up -d
curl -fsS http://127.0.0.1:8787/health/ready
```

镜像非 root 运行、capabilities 全部 drop、root filesystem read-only，只持久化服务状态与 Codex home。Dockerfile 对 Node 24.19.0 base image 使用 immutable multi-platform digest。

## 连接 GitLab

通过可信 HTTPS ingress / reverse proxy 暴露：

```text
POST https://<review-host>/webhooks/gitlab
```

启用 **Merge request events** 与 **Note events**。Signing Token 使用 `GITLAB_WEBHOOK_SIGNING_TOKEN` 或 `_FILE` 形式。

## Durable 架构

```text
GitLab MR open/update
        ↓
签名 Webhook
        ↓
SQLite durable review queue
        ↓
immutable start_sha + head_sha evidence
        ↓
Codex Safe Review
        ↓
SQLite Review Receipt
        ├─ GitLab Publication Outbox
        │    ├─ status
        │    ├─ summary
        │    └─ discussions
        └─ Notification Outbox
             ├─ 飞书/Lark
             └─ 企业微信
```

GitLab 是 Review System of Record；SQLite 是服务 durable state；IM 只是 Attention Router，不参与 Verdict 和审批。

## 多仓库与信任边界

一个实例可管理显式 Projects、Group 层级或两者。Group discovery 分页、fail closed；刷新不完整时保留上一次完整 scope。

```json
"projects": [101, 102, 103],
"groups": [{ "id": 20, "includeSubgroups": true }]
```

**一个 Service 实例就是一个管理/安全信任域。** 如果不同仓库属于不同凭据域、保密级别或 OpenAI 数据策略，应部署不同实例，不在单实例内部引入隐式多租户复杂度。

## IM 通知

飞书/Lark、企业微信使用独立 durable `notification_outbox`，具备确定性 Card、幂等、bounded retry、重启恢复与 terminal failure。通知失败**不会改变 Review Verdict，也不会重新调用 Codex**。

详见 [IM 通知](docs/NOTIFICATIONS.zh-CN.md)。

## Health、SLO 与运维

```text
GET /health/live           进程存活
GET /health/ready          是否可安全接收并持久化 Webhook
GET /health/dependencies   GitLab/scope 依赖健康
GET /version               产品/运行时身份
GET /metrics               Prometheus metrics
```

`/health/ready` 不会因为 GitLab 临时故障而必然摘除仍可安全持久化 Webhook 的实例；外部依赖异常单独进入 degraded 状态。

内建 Admin CLI：

```bash
npm run admin -- status
npm run admin -- jobs
npm run admin -- publications
npm run admin -- notifications
npm run admin -- retry-publication <id>
npm run admin -- retry-notification <id>
npm run admin -- drain 60
npm run admin -- reconcile
npm run admin -- db-check
npm run admin -- backup /secure-backup/review.sqlite
npm run admin -- backup-verify /secure-backup/review.sqlite
npm run admin -- diagnostics
```

备份使用 Node 24 SQLite online backup API；只有 `quick_check`、foreign key 与 Schema 5 全部通过才接受备份。

## 故障语义

Review、GitLab Publication、IM Notification 是独立 durable failure domain。Publication / Notification 重试不会重新运行已经持久化的 Codex Review。未知 `unhandledRejection` / `uncaughtException` 被视为 fatal：停止接收、关闭 worker、checkpoint durable state、非零退出，再由 systemd/Docker restart 与恢复逻辑接管。

## 配置归属

```text
/etc/codex-review/config.json      非 Secret Config Schema 1
/etc/codex-review/secrets/*        受保护 Secret 文件
/var/lib/codex-review              SQLite/state
```

Direct user mode 使用 XDG config/state defaults。运行时不猜测 root/sudo/systemd 模式。

## Upgrade 契约

Schema 5 是第一个正式生产数据库。**v5.0.0 之后，已发布数据库与配置兼容性正式成为产品契约。** 后续 DB / Config Schema 变化必须提供显式 migration fixture、forward upgrade test 与 rollback boundary，不能再把首发前 hard-cut 当作正常升级方式。

## 永久 Gate

PR/Release 会覆盖 Node 24 floor/current-major、Docker build/smoke、恢复/备份、Dependency Review、CodeQL、真实 GitLab CE Provider 矩阵、package boundary、OCI vulnerability scan、SBOM、checksum 与 GitHub provenance attestation。

- 部署：[docs/DEPLOYMENT.zh-CN.md](docs/DEPLOYMENT.zh-CN.md)
- GitLab 配置：[docs/GITLAB_SETUP.zh-CN.md](docs/GITLAB_SETUP.zh-CN.md)
- IM 通知：[docs/NOTIFICATIONS.zh-CN.md](docs/NOTIFICATIONS.zh-CN.md)
- Docker：[deploy/docker/README.md](deploy/docker/README.md)
- 运维/升级/灾备：[OPERATIONS.md](OPERATIONS.md)
- Support：[SUPPORT.md](SUPPORT.md)
- Security：[SECURITY.md](SECURITY.md)
- Architecture：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Release 验证：[VERIFY_RELEASE.md](VERIFY_RELEASE.md)

## License

MIT
