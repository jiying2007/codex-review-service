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

## Release Integrity：区分发布与无发布

`Release` 工作流既支持真正的不可变版本发布，也会在已发布版本、无新产品版本的普通 `main` push 上完成一次**无发布**的检查。过去仅凭父工作流 `conclusion=success` 就按新 SHA 检查旧版 tag，会把合法的无发布推送误报为 Release Integrity 失败。

现在 `Prepare release` 在同一个 GitHub run/attempt 下保存严格的发布意图（repo/run ID/attempt/source HEAD/source event/tag/release SHA/publish 布尔值）。`Release Integrity` 必须从**原始 Release 作业**读取真正的 `Package / OCI / attest / publish` 结论和最终发布步骤，并重新绑定该意图：

- `prepare=skipped`、`publish=skipped`：无匹配的有效发布请求；正常结束且不伪造发行记录
- `prepare=success`、`publish=skipped`，并且原始意图 `publish=false`：普通无发布推送；完整性检查标记不适用
- `prepare=success`、`publish=success`，并且最终 `Publish immutable GitHub Release` 步骤真的成功且原始意图 `publish=true`：调用原 Core `consumer-release-integrity.yml`，以**实际发行源码 SHA**校验 immutable tag、assets 与来源证明
- 来源 Job 缺失、重复、失败、签名意图缺失/不一致、验证失败：`Release Integrity Gate` 必须失败；不能返回绿色的“无发布”

对于受支持的 `/release-retry`，原始 Release workflow 的 HEAD 与实际被恢复的 immutable tag SHA 可能不同，必须使用**来源作业记录的发行 SHA**，不能拿当前 main SHA 硬套旧 tag。保留产品版本、Node 全量、OCI、SBOM、provenance、Trivy Critical、签名/不可变资产和生产回滚要求，不修改批准边界。

此项仅改变 Release Integrity 对**实际成功出版还是普通无发布推送**的判定，不会让 PR CI 的局部结果代替真正 Release CI，也不表示私仓主线已有 GitHub 原生 Ruleset。

## 私有仓库 OpenSSF Scorecard 权限不足

`OpenSSF Scorecard` 原生 Action 需要读取 GitHub GraphQL `ListCommits` 等源数据，但在现有私有仓库默认的 `github.token` 下，多轮执行真实返回 `Resource not accessible by integration`，与漏洞检测结果不同。

对于**私有** Service，只将此项标为**不适用 / 未扫描**，不再每次主线推送生成一条相同的权限故障；如果改为公开仓库则按原 SHA 固定的 Scorecard Action 正常执行。此状态不代表 Scorecard PASS，也不生成空 SARIF 或假合格回执。

**不降低生产安全门禁**：正常 PR 的依赖/许可证与项目测试、main 的安全工作流、正式 Release 的 Trivy Critical、SBOM、provenance、签名及不可变性验证都保持原样。若管理员未来提供真正可用的独立 GitHub 认证上下文，可再以单独、可复核的 PR 恢复私有 Scorecard；不得把缺乏扫描权限的结果冒充安全通过。
