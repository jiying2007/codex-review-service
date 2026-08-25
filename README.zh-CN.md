# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

面向 **GitLab Self-Managed Merge Request** 的生产级、自托管 Codex Review 服务。当前正式产品基线为 **v5.0.1**：一个管理/安全信任域可覆盖多个显式 Project / Group，同时提供 durable GitLab Publication 与可选的飞书/Lark、企业微信确定性通知。

## 产品契约

`product-contract.json` 是唯一机器校验的产品事实源：

- Service：**5.0.1**
- Database Schema：**5**
- Config Schema：**1**
- Policy Schema：**3**
- Review Receipt：**4**
- Safe Contract：**2**
- Safe Core：精确提交 `7ffbf6f1791e17ba74faf0922e7a702bdac72059`
- Node.js：**>=24.19.0 <25**
- GitLab Self-Managed：**>=19.1.0**

当前 CI 会对真实 GitLab CE 19.1.x 与当前认证版本线执行 Provider 契约。Safe Core 仍是 Family v4，Service v5 不改变共享 Review 协议。

## 适用场景

当你希望 MR Review 在服务器侧运行、独立于开发者工作站，并确定性发布 GitLab status / summary / discussions 时使用本产品。

推荐生产部署：

> **systemd + inline Runner + 单机本地 SQLite**

只有在必须把 GitLab 凭据与 Codex/OpenAI 凭据拆到不同 Unix 用户/进程时才使用 isolated Runner。Docker/Compose 同样是一等部署方式，但生产环境应消费 Release 发布的 **digest 固定 `compose.release.yaml` / GHCR 镜像**，不要在目标机器重新 build 源码。

## 5 分钟部署

优先把经过验证的 `codex-review-service-5.0.1.tgz` 安装到 `/opt/codex-review-service`。

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo install -d -o root -g codex-review -m 0750 /etc/codex-review/secrets
sudo install -m 0644 deploy/systemd/config.example.json /etc/codex-review/config.json
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/
```

Secret 推荐使用 `_FILE`：

```text
GITLAB_API_TOKEN_FILE=/etc/codex-review/secrets/gitlab-api-token
GITLAB_WEBHOOK_SIGNING_TOKEN_FILE=/etc/codex-review/secrets/gitlab-webhook-signing-token
OPENAI_API_KEY_FILE=/etc/codex-review/secrets/openai-api-key
```

直接值与 `_FILE` 二选一，同时存在会 fail closed。配置必须包含 `schemaVersion: 1`，并设置 `gitlab.baseUrl`、`gitlab.projects` 和/或 `gitlab.groups`。

```bash
cd /opt/codex-review-service
sudo -u codex-review /usr/bin/node --env-file=/etc/codex-review-service.env src/doctor.js
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
curl -fsS http://127.0.0.1:8787/health/dependencies
curl -fsS http://127.0.0.1:8787/version
```

Doctor 和 `/health/ready` 通过之前不要启用 GitLab Webhook。Webhook 入口为 `/webhooks/gitlab`，启用 **Merge request events** 与 **Note events**。

## Docker / Compose

正式 Release 发布 canonical 多架构 GHCR 镜像、OCI SBOM/provenance、`IMAGE_DIGEST.txt` 与 digest 固定的 `compose.release.yaml`。镜像非 root 运行、capabilities 全部 drop、root filesystem read-only，只持久化服务状态与 Codex home；构建完成后会从最终 runtime 中移除 npm/npx/yarn/corepack，只保留 `node` 与 `codex` 所需执行面。

```bash
mkdir -p secrets
chmod 0700 secrets
printf '%s' "$GITLAB_API_TOKEN" > secrets/gitlab_api_token
printf '%s' "$GITLAB_WEBHOOK_SIGNING_TOKEN" > secrets/gitlab_webhook_signing_token
chmod 0600 secrets/*
docker compose -f compose.release.yaml up -d
```

## Durable 架构与边界

```text
GitLab MR → signed webhook → SQLite durable review queue → Codex Safe Review
                                              ↓
                                     SQLite Review Receipt
                                      ├─ GitLab Publication Outbox
                                      └─ Notification Outbox
```

GitLab 是 Review System of Record；SQLite 是服务 durable state；IM 只是 Attention Router，不参与 Verdict 和审批。一个 Service 实例就是一个管理/安全**信任域**，不同凭据域、保密级别或 OpenAI 数据策略应部署不同实例。

## Health、SLO 与运维

```text
GET /health/live
GET /health/ready
GET /health/dependencies
GET /version
GET /metrics
```

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

备份使用 Node 24 SQLite online backup API；只有 `quick_check`、foreign key 与 Schema 5 全部通过才接受备份。未知 `unhandledRejection` / `uncaughtException` 被视为 fatal，由 durable restart/recovery 接管。

## Upgrade 契约

Schema 5 是第一个正式生产数据库。**从 v5.0.0 起，已发布数据库与配置兼容性正式成为产品契约。** 后续 DB / Config Schema 变化必须提供显式 migration fixture、forward upgrade test 与 rollback boundary，不能再把首发前 hard-cut 当作正常升级方式。

## 永久 Gate

PR/Release 覆盖 Node 24、Docker build/smoke、恢复/备份、Dependency Review、CodeQL、真实 GitLab CE Provider 矩阵、package boundary、OCI vulnerability scan、SBOM、checksum 与 GitHub provenance attestation。

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
