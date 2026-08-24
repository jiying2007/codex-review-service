# Codex Review Service

[English](README.md) | [简体中文](README.zh-CN.md)

面向 GitLab Self-Managed Merge Request 的生产级、自托管 Codex 审核执行服务。本仓库是 **Codex Safe Family v4** 的服务端 Enforcement 成员，消费唯一精确 commit-pinned 的 `codex-safe-core` 4 Runtime，并与本地 Review / Commit / PR 产品共用 Safe Contract v2、Policy Schema v3、Review Evidence、确定性 Review Rules 与 Review Receipt v4。

## 产品族边界

```text
                     codex-safe-core 4
              Safe Contract v2 / Policy v3
           Review Evidence / Rules / Receipt v4
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
- 执行用户完成 Codex CLI 登录，或提供 `OPENAI_API_KEY`

## 唯一配置语义

所有非 Secret 配置始终只来自一份 JSON Schema；不同运行方式只决定文件位置，不产生第二套配置模型或隐藏优先级。

普通用户直接运行时默认：

```text
${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json
```

如果 `server.dataDir` 未配置，持久状态默认：

```text
${XDG_STATE_HOME:-$HOME/.local/state}/codex-review/
```

根目录 [`config.example.json`](config.example.json) 是普通用户友好的中性模板，刻意不设置 `server.dataDir`，复制后不会重新引入 root 拥有目录。`CODEX_REVIEW_CONFIG_FILE` 可显式选择其他配置文件；相对路径形式的 `XDG_CONFIG_HOME` / `XDG_STATE_HOME` 不采用，回退到标准 `$HOME` 路径。

系统级 systemd 部署使用 [`deploy/systemd/config.example.json`](deploy/systemd/config.example.json)，该模板显式把状态固定到 `/var/lib/codex-review`；Controller 与 Runner 两个 systemd unit 都显式设置 `CODEX_REVIEW_CONFIG_FILE=/etc/codex-review/config.json`。Runtime 不检测 root、sudo 或 systemd。

支持的环境变量严格限制为：

```text
CODEX_REVIEW_CONFIG_FILE
GITLAB_API_TOKEN
GITLAB_WEBHOOK_SIGNING_TOKEN
OPENAI_API_KEY
```

不存在非 Secret 环境覆盖层。

## 普通用户直接运行

默认不依赖任何 root 拥有目录：

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/codex-review"
cp config.example.json "${XDG_CONFIG_HOME:-$HOME/.config}/codex-review/config.json"
# 修改复制后的 GitLab Scope。

export GITLAB_API_TOKEN=...
export GITLAB_WEBHOOK_SIGNING_TOKEN=...
codex login
npm start
```

默认 Runner 模式是 `inline`。如果明确要在 systemd 之外直接运行 isolated Runner，请自行把 `runner.socket` 配置为 Controller 与 Runner 都可写的绝对路径；systemd 模板中的 `/run/codex-review-runner/runner.sock` 是系统级部署选择，不是通用 Runtime fallback。

## 系统级部署

默认生产拓扑是一个 Controller + Inline Codex：

```text
GitLab → codex-review-service
            ├─ SQLite WAL + synchronous=FULL
            ├─ Review Workers
            ├─ Transactional Publication Outbox
            └─ Codex Safe Core → Codex CLI
```

```bash
sudo useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
sudo mkdir -p /etc/codex-review

git clone --recurse-submodules https://github.com/jiying2007/codex-review-service.git /opt/codex-review-service
cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund
npm run core:init

sudo install -m 0644 deploy/systemd/config.example.json /etc/codex-review/config.json
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
    "groups": [{ "id": 20, "includeSubgroups": true }]
  },
  "review": { "concurrency": 4 },
  "runner": { "mode": "inline" }
}
```

Group discovery 支持分页并 fail-closed：只有完整发现成功后才原子替换 Scope；失败时保留上一次完整集合并让 readiness 变为 unhealthy。不同 MR 可并发，同一 MR 始终串行。

## Hardened Deployment

在 systemd 配置中设置 `runner.mode="isolated"`，把 GitLab 凭据与 Codex/OpenAI 凭据隔离到不同用户/进程。Controller 与 Runner 读取同一份 canonical `config.json`；系统级部署下两个 unit 都显式指向 `/etc/codex-review/config.json`，Runner 不持有 GitLab 凭据。

## GitLab Webhook

启用 GitLab 19.1+ **Merge request events** 和 **Note events**。服务校验 Standard Webhooks 签名元数据、原始 Body HMAC、时间窗、GitLab Instance、Delivery ID 与已解析 Scope，并在持久入队后返回。

## Repository Policy v3

唯一仓库策略文件是目标分支的 **`.codex-safe.json`**，从不可变 `diff_refs.start_sha` 读取并由 pinned Core closed schema 校验。仓库策略只能收紧资源和增强确定性 Gate，不能削弱服务全局 Blocking / Confidence / Security / Capacity 边界。

## Review Evidence 与 Receipt

Provider patch 会规范化为 Core Review Evidence chunk，不允许静默截断 changed hunk。Finding 必须精确映射 changed line，绝不修补或迁移模型行号。

SQLite schema **4** 在同一 durable transaction 中保存 canonical GitLab-MR Review Receipt v4、Run、Findings 与 Publication Plan。SQLite 仍是 Service Source of Truth；Receipt v4 是跨产品 Audit/Provenance 投影。

## 长期不变量

- SQLite 本地文件系统 `WAL + synchronous=FULL`；
- Review 与 GitLab Publication 是独立 durable failure domain；
- 每次审核绑定 target `start_sha` + source `head_sha`；
- stale 或 out-of-scope 结果不能发布；
- Publication retry 不会重新执行已持久化 Review；
- Projects/Groups Scope 完整发现、原子替换、失败关闭；
- GitHub Actions 全部 full-SHA pin。

## Health / Doctor

```text
GET /health/live
GET /health/ready
GET /metrics
```

`npm run doctor` 验证 canonical config、状态/数据库、Core-backed Codex/Runner capability、GitLab 可达性与完整 Project/Group Scope，不执行被审核仓库代码。

详见 [OPERATIONS.md](OPERATIONS.md)、[SECURITY.md](SECURITY.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[LONG_TERM_ASSET.md](LONG_TERM_ASSET.md)、[VERIFY_RELEASE.md](VERIFY_RELEASE.md)、[CHANGELOG.md](CHANGELOG.md)。

## 开发与发布

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run core:init
npm run ci
npm pack --dry-run --ignore-scripts
npm run release:check
```

CI 同时验证 Node.js 22.13.0 与 Node.js 24。版本发布生成 immutable TGZ、SPDX SBOM、SHA256、provenance attestation 与 immutable `v<version>` Tag/Release。下载后的产物按 [VERIFY_RELEASE.md](VERIFY_RELEASE.md) 同时验证 checksum 与 provenance。
