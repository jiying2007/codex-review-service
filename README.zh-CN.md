# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

面向 GitLab Self-Managed Merge Request 的生产级、自托管 Codex 审核执行服务。**v3.0 是 Codex Safe 产品族的服务端 Enforcement 成员**：与本地 Review / Commit / PR 产品共用 commit-pinned `codex-safe-core`、Policy Schema v3、Review Evidence、确定性 Review Rules 与 Review Receipt v4。

## 产品族边界

```text
                     codex-safe-core 3.0.1
              Safe Contract v2 / Policy v3
           Review Evidence / Rules / Receipt v3
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
Codex Review Safe   Codex Commit Safe    Codex PR Safe
       │
       └───────────────────────────────┐
                                       ▼
                              Codex Review Service
                              GitLab 服务端 Enforcement
```

Core 负责跨产品共用的 Codex / Process / Policy / Review Evidence / Receipt 语义；Service 只负责 GitLab Provider、MR immutable evidence、SQLite、Queue、Outbox、Publication、状态/Discussion、可观测性和部署。

## 环境要求

- Node.js **22.13+**
- GitLab Self-Managed **19.1+**，使用 Standard Webhooks Signing Token
- 仅授予必要 Project/Group/MR/Repository/Discussion/Status 权限的 GitLab API Token
- Standard 模式由服务用户登录 Codex CLI；Hardened 模式由独立 Runner 用户登录

## 唯一配置模型

所有非 Secret 服务配置仍只来自一份 JSON。普通用户直接运行时默认：

```text
${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json
```

持久状态默认：

```text
${XDG_STATE_HOME:-$HOME/.local/state}/codex-review/
```

`CODEX_REVIEW_CONFIG_FILE` 可显式覆盖配置路径。相对路径形式的 `XDG_CONFIG_HOME` / `XDG_STATE_HOME` 不采用，回退到标准 `$HOME` 路径。系统级 systemd 部署显式固定 `/etc/codex-review/config.json`，生产配置示例显式使用 `/var/lib/codex-review` 保存状态。

环境变量仅允许：

```text
CODEX_REVIEW_CONFIG_FILE
GITLAB_API_TOKEN
GITLAB_WEBHOOK_SIGNING_TOKEN
OPENAI_API_KEY
```

不存在非 Secret 环境覆盖层。

## 普通用户直接运行

默认不再依赖 root 拥有的目录：

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/codex-review"
cp config.example.json "${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json"
# 修改 GitLab Scope；如希望使用 XDG State 默认目录，可删除 server.dataDir

export GITLAB_API_TOKEN=...
export GITLAB_WEBHOOK_SIGNING_TOKEN=...
codex login
npm start
```

## Standard Deployment

默认生产拓扑：

```text
GitLab → codex-review-service
            ├─ SQLite WAL + synchronous=FULL
            ├─ Review Workers
            ├─ Transactional Publication Outbox
            └─ Codex Safe Core → Codex CLI（Inline）
```

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo mkdir -p /etc/codex-review

git clone --recurse-submodules https://github.com/jiying2007/codex-review-service.git /opt/codex-review-service
cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund
npm run core:init

sudo install -m 0644 config.example.json /etc/codex-review/config.json
sudo install -o root -g codex-review -m 0640 .env.example /etc/codex-review-service.env
sudo install -m 0644 deploy/systemd/codex-review-service.service /etc/systemd/system/

sudo -u codex-review -H codex login
sudo -u codex-review /usr/bin/node --env-file=/etc/codex-review-service.env src/doctor.js
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-service
curl -fsS http://127.0.0.1:8787/health/ready
```

## 多仓库 Scope

一个实例可同时管理 Projects 与 Groups：

```json
{
  "gitlab": {
    "baseUrl": "https://gitlab.example.internal",
    "projects": [101, 102],
    "groups": [
      { "id": 20, "includeSubgroups": true }
    ]
  },
  "review": { "concurrency": 4 },
  "runner": { "mode": "inline" }
}
```

Group discovery 支持分页并 fail-closed：只有完整发现成功后才原子替换 Scope；失败时保留上一次完整集合并让 readiness 变为 unhealthy。不同 MR 可并发，同一 MR 始终串行。

## Hardened Deployment

```json
{
  "runner": {
    "mode": "isolated",
    "socket": "/run/codex-review-runner/runner.sock"
  }
}
```

Controller 与 Runner 读取同一份 `config.json`。Controller 持有 GitLab 凭据与 SQLite；Runner 只持有 Codex/OpenAI 凭据，通过 Unix socket 接收有界审核输入，不持有 GitLab 凭据。系统级 Hardened 部署由两个 systemd unit 显式指向同一份 `/etc/codex-review/config.json`。两种模式执行完全相同的 Safe Core Runtime 与 Safe Contract。

## GitLab Webhook

启用 GitLab 19.1+ **Merge request events** 和 **Note events**：

```text
https://review.example.internal/webhooks/gitlab
```

服务强制校验 `webhook-id`、`webhook-timestamp`、`webhook-signature`、原始 Body HMAC、时间窗、`X-Gitlab-Instance` 与 delivery 去重，完成本地持久入队后快速返回。

## Repository Policy v3

唯一仓库策略文件是目标分支的 **`.codex-safe.json`**。Service 只从精确 `diff_refs.start_sha` 读取，并由 pinned Core closed schema 校验。参考 [`.codex-safe.example.json`](.codex-safe.example.json)。

```json
{
  "schemaVersion": 3,
  "review": {
    "language": "zh-CN",
    "maxDiffBytes": 524288,
    "maxFindings": 30,
    "severityThreshold": "low",
    "confidenceThreshold": 0.7,
    "rules": {
      "requireTestsForCodeChanges": true,
      "codePathPrefixes": ["src/"],
      "testPathPrefixes": ["test/", "tests/"],
      "forbiddenPathPrefixes": []
    }
  },
  "reviewService": {
    "maxContextBytes": 131072,
    "maxContextFiles": 8,
    "contextLines": 16,
    "skipGeneratedFiles": true,
    "blockUnreviewableFiles": false
  }
}
```

`review` 是本地 Review Safe 与 Service 共用语义；`reviewService` 只承载服务端 Provider/Context 控制。仓库策略只能收紧资源与增强 Gate，不能削弱服务全局 Blocking / Confidence / Security / Capacity 边界。

## Review Evidence 与精确 changed-line

GitLab 常见的 hunk-only patch 会先由 Provider Adapter 规范化为 canonical unified diff，再进入 Core `buildReviewEvidenceChunks()`。`maxDiffBytes` 是 Review Evidence chunk 预算；changed hunk 不允许静默 head/tail 截断，一个 hunk 要么被审核，要么产生明确 coverage gap。

Service 仍保留完整 Provider diff 元数据用于精确 `old/new` changed-line 校验和稳定 anchor。模型 Finding 不做 nearest-line/±N 行迁移。

## Immutable Context

Service 只通过 GitLab Repository API，在精确 source `head_sha` 与 target `start_sha` 上读取有界源码窗口；不会 checkout 或执行被审核仓库代码。Core 消费这些有界 Evidence，但不负责 GitLab Provider 访问。

## Review Receipt v4 与 SQLite schema 4

SQLite schema **4** 在 `review_runs` 中保存 canonical GitLab-MR Review Receipt v4 与 fingerprint。Receipt、Run、Findings、Publication Plan 在同一个 `BEGIN IMMEDIATE` 事务内提交。

Receipt 绑定：

```text
projectId + MR iid + startSha + headSha
+ diff fingerprint + policy fingerprint
+ quality/readiness/mechanical/coverage verdicts
+ model + Codex version + timestamp
```

SQLite 仍是 Service Source of Truth；Receipt v3 只是跨产品 Audit/Provenance 投影，不是第二套存储系统。

## 长期不变量

- SQLite `WAL + synchronous=FULL`；
- Review 与 GitLab Publication 通过事务性 Outbox 分离；
- 审核绑定 target `start_sha` + source `head_sha`；
- stale snapshot 与移出 Scope 的旧 Publication 不能继续写 GitLab；
- Status 绑定 source project/ref，并尽量绑定精确 `pipeline_id`；
- Finding 必须精确 changed-line，不做 relocation；
- Finding identity 使用稳定 code anchor；
- Provider / Context / Evidence coverage gap fail-closed；
- deterministic `review.rules` 来自 Safe Core；
- Token usage 与 MR/Project Budget 持久化执行；
- GitLab API 有限速、Retry-After 与 Circuit Breaker；
- GitHub Actions 全部 full-SHA pin。

## Health / Doctor

```text
GET /health/live
GET /health/ready
GET /metrics
```

`npm run doctor` 验证 canonical config、SQLite durability/schema、Core-backed Codex/Runner capability、GitLab 可达性与完整 Project/Group Scope，不执行真实代码审核。

详见 [OPERATIONS.md](OPERATIONS.md)、[SECURITY.md](SECURITY.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[LONG_TERM_ASSET.md](LONG_TERM_ASSET.md)、[CHANGELOG.md](CHANGELOG.md)。

## 开发与发布

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run core:init
npm run ci
npm pack --dry-run --ignore-scripts
npm run release:check
```

CI 同时验证 Node.js 22.13.0 与 Node.js 24。`main` 上版本变化会触发 Release workflow：再次执行双 Node Gate，生成唯一 `codex-review-service-<version>.tgz`、`SHA256SUMS` 与 GitHub build-provenance attestation，创建/校验不可变 `v<version>` Tag，并发布 GitHub Release。
