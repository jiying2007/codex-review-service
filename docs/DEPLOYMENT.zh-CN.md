# Codex Review Service 部署指南

本文给出 v4.0.4 推荐生产部署：**systemd + inline Runner + 本地 SQLite**，最后再说明可选 isolated Runner。

## 1. 先确定管理 Scope

一个实例可以管理多个 Project、整个 Group，或两者混用：

```json
"gitlab": {
  "baseUrl": "https://gitlab.example.internal",
  "projects": [101, 102],
  "groups": [{ "id": 20, "includeSubgroups": true }]
}
```

使用 GitLab 数字 Project/Group ID。Group discovery 支持分页并 fail closed。

## 2. 安装运行环境

要求：

- Linux + systemd
- Node.js 22.13+
- Git
- OpenAI Codex CLI
- GitLab Self-Managed 19.1+

安装 immutable release：

```bash
sudo useradd --system --create-home \
  --home-dir /home/codex-review \
  --shell /usr/sbin/nologin \
  codex-review

sudo mkdir -p /etc/codex-review

git clone --branch v4.0.4 --recurse-submodules \
  https://github.com/jiying2007/codex-review-service.git \
  /opt/codex-review-service

cd /opt/codex-review-service
npm ci --ignore-scripts --no-audit --no-fund
npm run core:init
```

后续版本把 `v4.0.4` 替换成明确选择的 immutable Release Tag，并按 `VERIFY_RELEASE.md` 校验产物。

## 3. 安装非 Secret 配置

```bash
sudo install -m 0644 \
  deploy/systemd/config.example.json \
  /etc/codex-review/config.json

sudo editor /etc/codex-review/config.json
```

至少修改：

- `gitlab.baseUrl`；
- `gitlab.projects` 和/或 `gitlab.groups`；
- 如果实例地址不同，修改 `webhook.expectedInstance`；
- 仅在默认值不适合时调整 concurrency/capacity。

第一次部署保持 `runner.mode="inline"`。

## 4. 创建 Credential

创建最小权限的 GitLab Project/Group Access Token，覆盖所配置 Scope 的 API 访问、MR/Repository 读取、Discussion 与 Commit Status 发布。

生成 Service 所需 Standard Webhooks Signing Token：

```bash
echo "whsec_$(openssl rand -base64 32)"
```

安装 Secret env：

```bash
sudo install -o root -g codex-review -m 0640 \
  .env.example \
  /etc/codex-review-service.env

sudo editor /etc/codex-review-service.env
```

配置：

```text
GITLAB_API_TOKEN=...
GITLAB_WEBHOOK_SIGNING_TOKEN=whsec_...
```

可以额外配置 `OPENAI_API_KEY`；否则必须让真正运行 systemd 的用户登录 Codex：

```bash
sudo -u codex-review -H codex login
sudo -u codex-review -H codex --version
```

不要只用 root 登录 Codex，因为 Service 用户是 `codex-review`。

## 5. 安装 systemd 并先跑 Doctor

```bash
sudo install -m 0644 \
  deploy/systemd/codex-review-service.service \
  /etc/systemd/system/codex-review-service.service

sudo systemctl daemon-reload
```

**启动前先跑 Doctor：**

```bash
cd /opt/codex-review-service
sudo -u codex-review \
  /usr/bin/node \
  --env-file=/etc/codex-review-service.env \
  src/doctor.js
```

Doctor 会检查 Config、State/Database、Codex capability、GitLab 可达性与 Project/Group Scope，不执行被审核仓库代码。

Doctor 成功后：

```bash
sudo systemctl enable --now codex-review-service
systemctl status codex-review-service
journalctl -u codex-review-service -f
```

验证：

```bash
curl -fsS http://127.0.0.1:8787/health/live
curl -fsS http://127.0.0.1:8787/health/ready
curl -fsS http://127.0.0.1:8787/metrics
```

`/health/ready` 成功前不要开启 GitLab Webhook。

## 6. 配置可信 HTTPS Ingress

Service 建议继续监听 `127.0.0.1:8787`，TLS 终止在可信内部 Nginx/Ingress。示例：

```nginx
server {
    listen 443 ssl;
    server_name review.example.internal;

    ssl_certificate     /etc/nginx/ssl/review.crt;
    ssl_certificate_key /etc/nginx/ssl/review.key;

    location /webhooks/gitlab {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 2m;
    }

    location /health/ {
        allow 10.0.0.0/8;
        deny all;
        proxy_pass http://127.0.0.1:8787;
    }

    location /metrics {
        allow 10.0.0.0/8;
        deny all;
        proxy_pass http://127.0.0.1:8787;
    }
}
```

尽量只允许 GitLab/可信网络访问 Webhook；Health/Metrics 只开放给可信监控系统。

## 7. 配置 GitLab Webhook

URL：

```text
https://review.example.internal/webhooks/gitlab
```

开启：

- Merge request events
- Note events

Signing Token 使用与 `GITLAB_WEBHOOK_SIGNING_TOKEN` 相同的 Standard Webhooks Signing Token。

当前基线要求 GitLab 19.1+ Standard Webhooks Signing 语义，不兼容旧纯文本 `X-Gitlab-Token`。

## 8. 第一次上线验收

用测试 MR 验证：

1. Signed Webhook 被接受；
2. MR 出现 `running` 状态；
3. SQLite 只持久化一份对应 Review Run；
4. Summary/Discussion/Status 从 Outbox 发布；
5. 最终 Status 进入 Terminal；
6. Source 新 Push 会使旧 Snapshot superseded；
7. `/health/ready` 保持健康；
8. Log/Metrics 不包含仓库内容或 Credential。

## 9. Repository Policy

可在被审核仓库目标分支提交 `.codex-safe.json`。Service 从 immutable target `diff_refs.start_sha` 读取，不使用 MR Source Branch 自己提交的弱化 Policy。

Repository Policy 可以加强 Rules、降低资源上限，但不能削弱 Service 全局 Security、Confidence/Blocking 或 Capacity 边界。

## 10. Hardened isolated Runner

只有明确需要凭据进程隔离时使用。

创建 Runner 用户，并共享 `codex-review` Group：

```bash
sudo useradd --system --create-home \
  --home-dir /home/codex-review-runner \
  --shell /usr/sbin/nologin \
  --gid codex-review \
  codex-review-runner
```

配置：

```json
"runner": {
  "mode": "isolated",
  "socket": "/run/codex-review-runner/runner.sock"
}
```

安装：

```bash
sudo install -o root -g codex-review -m 0640 \
  deploy/systemd/codex-review-runner.env.example \
  /etc/codex-review-runner.env

sudo install -m 0644 \
  deploy/systemd/codex-review-runner.service \
  /etc/systemd/system/codex-review-runner.service
```

Runner 只持有 Codex/OpenAI Credential，不给 GitLab Token：

```bash
sudo -u codex-review-runner -H codex login
sudo systemctl daemon-reload
sudo systemctl enable --now codex-review-runner
sudo systemctl restart codex-review-service
```

切换拓扑后重新跑 Doctor/readiness。

## 11. 升级与回滚

升级前备份 SQLite，并记录当前 immutable Tag：

```bash
cd /opt/codex-review-service
git fetch --tags origin
git checkout <new-release-tag>
git submodule update --init --recursive
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
```

跑 Doctor 后重启 Runner（如果 isolated）和 Controller，并要求 readiness 成功。

回滚使用相同流程 checkout 之前记录的 immutable Tag。任何版本切换前先备份 SQLite；详细备份/恢复见 `OPERATIONS.md`。
