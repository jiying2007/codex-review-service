# 独立维护开发与发布治理

本仓库按“**开发轻量、发布严格**”执行。

## 普通 PR

所有 PR 都触发开发 CI，包括以堆叠功能分支为目标的 PR，而不仅是直接指向 `main` 的 PR。

普通 PR 的必需开发门禁：

- canonical Node **24.19.0** 上的完整产品 `npm run ci`；
- Docker 构建与运行时边界 smoke；
- 核心恢复/SQLite 健康测试；
- dependency review；平台不提供依赖图时回退到 `npm audit` 与许可证检查；
- 最终统一为一个 `CI Gate` 结果。

普通 PR 不再为了证明开发可合并而重复运行完整双 Node × 多 OS、CodeQL、真实 GitLab CE 三版本、故障注入和 Family Release Guard。

这不是删除测试，而是把它们移到更符合成本/风险的位置。

## main / 完整资格

合入 `main` 或人工运行完整 CI 时，必须额外执行：

- Node 22.22.2 兼容；
- Node 22.22.2 / 24.19.0 × Linux / Windows / macOS 的迁移与 Provider Contract portability；
- Security workflow；
- durable state 故障注入；
- GitLab CE 14.6.1 / 17.11.7 / 19.3.0 的真实 Provider 测试；
- Family Release Guard。

这些检查失败可以阻止正式发布，但不应让一个独立维护者因为“缺第二个人”而无法进行普通开发。

## 正式 Release

`.github/workflows/release.yml` 继续独立执行两个支持 Node 版本的完整 CI、npm package、SBOM、multi-arch OCI、Critical 漏洞阻断、OCI/文件 provenance 和不可变 GitHub Release。

涉及以下边界时，即使普通 PR 已通过，也不得省略真实发布/现场验收：

- Database Schema / migration；
- 生产配置或 Secret；
- GitLab Webhook、状态写入、Publication/Notification；
- 多 GitLab trust-domain 路由；
- 生产镜像、Compose、卷或回滚路径。

独立维护者可以自行合并开发变更；生产发布仍由机器证据、精确 SHA/digest 和可回滚操作边界约束。
