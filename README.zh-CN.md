# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

面向 **GitLab Self-Managed Merge Request** 的生产级、自托管 Codex Review 服务。当前产品身份由下方机器生成契约区块定义：一个管理/安全信任域可覆盖多个显式 Project / Group，同时提供 durable GitLab Publication 与可选的飞书/Lark、企业微信确定性通知。

## 产品契约

<!-- BEGIN GENERATED PRODUCT CONTRACT -->

`product-contract.json` 是唯一机器校验的当前产品身份：

- Service：**7.4.2**
- Database Schema：**8**
- Config Schema：**7**
- Policy Schema：**4**
- Review Receipt：**5**
- Safe Contract：**2**
- Safe Core：精确提交 `25467922eeebffa93b7c820f2ffa7590c1625381`
- Quality Platform：**3**
- Review Profile：**1**
- Profile Pack：**1**
- Impact Evidence：**2**
- Test Impact：**1**
- Analyzer Finding：**1**
- Analyzer Adapter：**1**
- Native/systemd Node.js：**Node 22 LTS >=22.22.2，或 Node 24 LTS >=24.19.0**；明确不支持 Node 23
- 官方 Docker runtime：**Node 24.19.0**
- GitLab Self-Managed 兼容下限：**14.6.1**
- GitLab 推荐策略：生产环境应运行 **GitLab 官方仍支持的版本**，兼容下限不代表建议长期停留在旧版本

<!-- END GENERATED PRODUCT CONTRACT -->

GitLab 兼容通过 capability profile 管理，而不是到处堆版本判断：

- **Classic profile**（`14.6.1` 到 `<15.7`）：使用 `GET .../merge_requests/:iid/changes`，只有 GitLab 明确返回 `overflow: false` 才允许继续 Review。
- **Modern profile**（`>=15.7`）：继续使用分页 `/diffs` + `/versions` + `real_size` 证明完整 diff 覆盖。

任一 profile 只要无法证明 diff 完整，就会在调用 Codex 前 fail closed。真实 Provider CI 覆盖 GitLab CE **14.6.1、17.11.7、19.3.0**。Safe Core 仍是 Family v4，Service v7.4 不改变共享 Review 协议。

## 适用场景

当你希望 MR Review 在服务器侧运行、独立于开发者工作站，并确定性发布 GitLab status / summary / discussions 时使用本产品。

推荐生产部署：

> **systemd + inline Runner + 单机本地 SQLite**

只有在必须把 GitLab 凭据与 Codex/OpenAI 凭据拆到不同 Unix 用户/进程时才使用 isolated Runner。Docker/Compose 同样是一等部署方式，但生产环境应消费 Release 发布的 **digest 固定 `compose.release.yaml` / GHCR 镜像**，不要在目标机器重新 build 源码。

## 5 分钟部署

优先把经过验证的 `codex-review-service-7.4.2.tgz` 安装到 `/opt/codex-review-service`。

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

OpenAI-compatible 中转站默认由 Runtime v3 复用 Service 用户/容器的 Family/Codex Runtime 与凭据来源；显式 `codex.provider*` 仅作为高级覆盖。完整说明见 [Codex Provider 与中转站配置](docs/CODEX_PROVIDER.zh-CN.md)。

直接值与 `_FILE` 二选一，同时存在会 fail closed。配置必须包含 `schemaVersion: 7`，并设置 `gitlab.baseUrl`、`gitlab.projects` 和/或 `gitlab.groups`。

```bash
cd /opt/codex-review-service
sudo -u codex-review /usr/bin/node --env-file=/etc/codex-review-service.env src/doctor.js
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
curl -fsS http://127.0.0.1:8787/health/dependencies
curl -fsS http://127.0.0.1:8787/version
```

Doctor 会输出检测到的 GitLab 版本及 `classic` / `modern` Provider profile，并真实探测配置的 Codex Provider。Doctor 和 `/health/ready` 通过之前不要启用 GitLab Webhook。

## 接入 GitLab Webhook

通过可信 HTTPS ingress / reverse proxy 暴露：

```text
POST https://<review-host>/webhooks/gitlab
```

在 GitLab Webhook 中启用 **Merge request events** 与 **Note events**，并使用与 `GITLAB_WEBHOOK_SIGNING_TOKEN` / `_FILE` 相同的 Standard Webhooks Signing Token。服务只在签名、实例、scope 与 replay/idempotency 校验通过后持久化事件。

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

官方 Docker 内已固定 Node 24.19，因此使用容器部署时主机 Node 版本不构成要求。

## GitLab 兼容与升级边界

GitLab 14.6.1 是**兼容下限**，不是推荐生产版本。当前已有旧 GitLab 的企业环境可以先部署 Review Service，不必为了 Service 强行先做跨多个 major 的 GitLab 升级；GitLab 本体升级应作为独立的基础设施/安全项目按官方升级路径推进。

Classic profile 对旧 `/changes` 的 `overflow` 信号 fail closed；Modern profile 对 `/diffs` 分页和 `/versions.real_size` fail closed。两者都坚持“不能证明完整变更，就不产生可信 Verdict”。

## Durable 架构与边界

```text
GitLab MR → signed webhook → SQLite durable review queue
                                  ↓
                     GitLab capability profile
                                  ↓
                         Codex Safe Review
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

备份使用两个受支持 Node LTS 版本都具备的 SQLite online backup API；只有 `quick_check`、foreign key 与 Schema 6 全部通过才接受备份。未知 `unhandledRejection` / `uncaughtException` 被视为 fatal，由 durable restart/recovery 接管。

## Upgrade 契约

Schema 5 是第一个正式生产数据库。**从 v5.0.0 起，已发布数据库与配置兼容性正式成为产品契约。** 后续 DB / Config Schema 变化必须提供显式 migration fixture、forward upgrade test 与 rollback boundary，不能再把首发前 hard-cut 当作正常升级方式。

## 永久 Gate

PR/Release 覆盖 Node 22.22.2 / 24.19.0、Docker build/smoke、恢复/备份、dependency audit、CodeQL、真实 GitLab CE 14.6.1 / 17.11.7 / 19.3.0 Provider 矩阵、package boundary、OCI vulnerability scan、SBOM、checksum 与 GitHub provenance attestation。

- 部署：[docs/DEPLOYMENT.zh-CN.md](docs/DEPLOYMENT.zh-CN.md)
- Codex Provider / 中转站：[docs/CODEX_PROVIDER.zh-CN.md](docs/CODEX_PROVIDER.zh-CN.md)
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

## GitLab 流程跟踪

Config Schema 7 提供默认关闭的 GitLab Flow Tracking，可跟踪 Pipeline 终态、MR 生命周期、Tag 与 Branch 创建/删除，并复用现有 durable notification outbox。整个路径确定性执行且绝不调用 Codex。详见 `docs/FLOW_TRACKING.zh-CN.md`。
