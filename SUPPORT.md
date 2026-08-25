# Support

Before opening an issue or escalating an incident, collect a **metadata-only** diagnostic bundle. Do not attach repository content, prompts, credentials or the full SQLite database.

## Preferred diagnostic command

```bash
cd /opt/codex-review-service
sudo -u codex-review /usr/bin/node \
  --env-file=/etc/codex-review-service.env \
  src/admin-cli.js diagnostics
```

Also collect:

```bash
node --version
codex --version
git -C /opt/codex-review-service rev-parse HEAD
systemctl status codex-review-service --no-pager
curl -fsS http://127.0.0.1:8787/health/live
curl -fsS http://127.0.0.1:8787/health/ready
curl -fsS http://127.0.0.1:8787/health/dependencies
curl -fsS http://127.0.0.1:8787/version
```

Run Doctor as the service user:

```bash
cd /opt/codex-review-service
sudo -u codex-review /usr/bin/node \
  --env-file=/etc/codex-review-service.env \
  src/doctor.js
```

For isolated Runner also collect `systemctl status codex-review-runner --no-pager`.

## Include

Include Service version/source SHA, product-contract identity, Node/Codex/GitLab versions, inline/isolated mode, configured Project/Group counts (not sensitive names), readiness/dependency-health error classes, Admin diagnostics and relevant metadata-only journal lines.

For queue/outbox incidents, `npm run admin -- status`, `publications`, or `notifications` may be useful. Redact payload content if repository metadata itself is sensitive.

## Never include

Do not post:

- GitLab API tokens or Webhook signing tokens;
- `OPENAI_API_KEY`, Codex auth state or any secret file contents;
- notification webhook/signing secrets;
- raw MR diffs, fetched context, prompts or private source;
- sensitive repository URLs/names/branch names;
- full SQLite databases;
- unredacted system environment dumps.

## Incident ownership

Startup/config/secret resolution/scope/readiness/queue/outbox/Admin/backup/GitLab publication/notification delivery belongs to this Service repository.

Shared Safe Contract/Core runtime/Policy/Receipt semantics belong to `codex-safe-core` after confirming the defect is shared across products.

GitLab platform outages/configuration belong to the GitLab administrator. Codex CLI capability regression should include the exact CLI version and Doctor error class; do not add a legacy fallback to bypass a failed Safe Contract capability probe.

## Recovery guidance

Do not delete queue/outbox rows or hand-edit SQLite to make an incident disappear. Fix the underlying cause and use the supported Admin retry/reconcile/backup/restore-check commands.

If integrity checks fail, stop the Controller, preserve the state directory for forensic analysis and restore only a verified backup.

## 中文

升级问题前优先运行 `src/admin-cli.js diagnostics`，并收集 Service/source SHA、`/version`、Node/Codex/GitLab 版本、inline/isolated 模式、Project/Group 数量、`/health/ready`、`/health/dependencies`、Doctor 错误类别及不含源码内容的日志。

不要上传任何 Token、Secret 文件内容、`OPENAI_API_KEY`、Codex 登录状态、通知 Webhook、原始 MR diff、Prompt、私有源码、敏感仓库名称或完整 SQLite 数据库。事故处理不要手工删除/修改 Queue 或 Outbox；使用 Admin CLI 的 retry/reconcile/backup/restore-check。
