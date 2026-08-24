# Support

Before opening an issue or escalating an incident, collect a minimal diagnostic bundle that does **not** contain repository content or credentials.

## Required diagnostics

```bash
node --version
codex --version
git -C /opt/codex-review-service rev-parse HEAD
systemctl status codex-review-service --no-pager
curl -fsS http://127.0.0.1:8787/health/live
curl -fsS http://127.0.0.1:8787/health/ready
```

Run Doctor as the service user:

```bash
cd /opt/codex-review-service
sudo -u codex-review /usr/bin/node \
  --env-file=/etc/codex-review-service.env \
  src/doctor.js
```

For isolated Runner also collect `systemctl status codex-review-runner --no-pager`.

Include Service version/tag, Node/Codex versions, GitLab version, inline/isolated mode, configured Project/Group counts (not private names), readiness/Doctor error class and relevant metadata-only journal lines.

Never post GitLab tokens, Webhook signing tokens, `OPENAI_API_KEY`, Codex auth state, raw MR diffs, prompts, private source, repository URLs/names when they are sensitive, or full SQLite databases.

## Common ownership

- Startup/config/auth/scope/readiness/queue/outbox/GitLab publication → this repository.
- Shared Safe Contract/Core runtime/Policy/Receipt semantics → `codex-safe-core` after confirming the issue is shared across products.
- GitLab platform outage/configuration → GitLab administrator.
- Codex CLI capability regression → capture exact CLI version and Doctor output; do not add a legacy fallback.

中文：升级问题前先收集 Service Tag、Node/Codex/GitLab 版本、inline/isolated 模式、Project/Group 数量、Doctor/readiness 错误和不含仓库内容的日志。不要上传任何 Token、OPENAI_API_KEY、Codex 登录状态、原始 MR diff、Prompt、私有源码或完整 SQLite 数据库。
