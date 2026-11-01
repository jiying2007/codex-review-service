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

对于 GitHub 账户/私仓本身未提供的可选平台能力，必须区分“代码失败”和“能力不可用”：

- Code Scanning API 可用时运行 CodeQL；私仓未启用该能力时，记录 capability 状态并跳过 CodeQL 上传，不制造失败。dependency audit、产品安全回归、真实 Provider/迁移测试以及 Release 的 SBOM/Trivy/Provenance 继续有效。
- OpenSSF Scorecard 依赖 GitHub API/GraphQL 能力；私仓无法访问时记录显式说明，不作为产品或发布失败。
- 这些降级只针对平台能力，不允许把真实扫描 finding、依赖漏洞、测试失败或发布验证失败改成成功。

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

## 正式发布增加同 SHA 主线 CI 准入

`.github/workflows/release.yml` 的正式 `Package / OCI / attest / publish` 作业必须在构建/推送之前，查询 GitHub 原生 `CI` 工作流中**和实际发行源码 SHA 完全相同、目标为 main、事件为 push** 的最新运行；该运行必须 `completed/success`，且真实 `CI Gate` Job 中的依赖检查 Step 已执行成功。

新流程只在 `publish=true` 时执行该准入。正常 `main` 推送而产品版本未变化时仍沿已有 Release Intent 检测，**不会**因没有新产品发行而阻断开发；正式发行则等待最长 25 分钟，CI 真实失败、取消、结果不一致、权限不足或超时均阻断，绝不生成虚构绿色 Gate。普通 PR 的 canonical Node24 `CI Gate` **不能**代替主线完整资格；需要 main 的 Node22/24、故障注入、真实 GitLab Provider、Security/Family Gate 一起成功。

任何主线在实际发行前再次前进都会阻断陈旧 push 的发版。受控 `/release-retry` 使用已固定的历史 release SHA 验证它自己的既有真实 main CI，不假装它等于当前 main。原有不可变 Tag/Release、SBOM、OCI、多架构、Trivy Critical、provenance 和生产回滚仍是独立必需条件。

此保护是对*发行端*的约束，不能替代 GitHub 私有仓库的原生主线 Ruleset；对于缺少平台授权的私有 CodeQL/Scorecard 检查，应记录明确的“不可用”，不是伪造实际扫描。

## Tag 首次创建的明确状态处理（不降发布门禁）

首次发布的 `vX.Y.Z` Tag 可能尚不存在。早期 Release 在 `Ensure immutable release tag` 使用 `gh api --jq '.object.sha' ... || true`，并将命令的标准输出当作 Tag SHA：当 API 返回 404 或异常时，不能仅根据是否输出了字符判断是否已有有效 Tag，且原日志只有 exit 1、难以定位。

现改为独立 `scripts/ensure-immutable-release-tag.js`，直接按 GitHub API 状态码处理：GET **200** 必须证明已有 Tag 对应完整 40 位提交 SHA；**404** 才允许 POST 创建；**403/其它错误** 均拒绝，不继续创建；POST **201** 也必须回读同一 Tag 并确认真实 SHA；**422** 只允许重读后确认他人并发创建的 Tag 与精确 SHA 相同，其他冲突一律拒绝。不存在“把 JSON `null` 当成已有 Tag SHA”的隐含路径。保留带作用域 Token、GitHub HTTPS、响应体大小上限和严格错误码，不输出 Token 或任意远端响应。

该修复不授权覆盖、删除、修改任一已存在 Tag，不跳过同 SHA main CI Gate、双 Node/Provider 安全验证、OCI/SBOM/漏洞/签名及 Release Integrity。GitHub API 若确实拒绝 Tag 写入，正式 Release 会留下明确 `ETAGREAD` / `ETAGCREATE` 错误，等待管理员修正权限，而不会伪造成功。

## 私有个人仓库的发行证明：能力等价性边界

2026-11-01 实际 [Release 41269163223](https://github.com/jiying2007/codex-review-service/actions/runs/41269163223) 已真实通过 Node22/24、同 SHA 主线 20/20 CI Gate、GHCR multiarch Buildx 与 Trivy Critical 检查，但 `actions/attest-build-provenance` 返回：`Feature not available for user-owned private repositories`。按 [GitHub Artifact Attestations 可用性说明](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)，Free/Pro/Team 仅支持公开仓库，要对私仓使用 Actions Artifact Attestations 需要 Enterprise Cloud。**不得通过将私有 Service 公开、输出伪造签名或把不可用的能力假装已扫描来解决**。

独立维护者零额外付费的受控替代分成两个不同、不能混为同等签名的证据：

1. Buildx 使用 `--provenance=mode=max --sbom=true`，在 GHCR digest 对应的 OCI index 中真实附带 linux/amd64、linux/arm64 的 BuildKit provenance/SBOM。正式 Publisher 必须从仓库按 `image@sha256:digest` 重读真实索引、双平台 attestation manifest、SLSA/SPDX 数据并生成 `BUILD_EVIDENCE.json`（绑定源码 SHA、镜像 digest、索引与证据 SHA256）。**这是 digest-bound 的构建元数据，非独立身份签名**，不得称为 GitHub Actions Attestation PASS。
2. 仓库启用 [GitHub Immutable Releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) 后，正式 GitHub Release 自动产生独立的**发行级**签名证明，绑定 tag、commit 和每个发布资产。新 `BUILD_EVIDENCE.json` 一并列入 `SHA256SUMS`、Actions artifact 和 Release assets。现有独立下游 `consumer-release-integrity.yml` 必须实际完成 `gh release verify` 与全部 `gh release verify-asset`，失败不得标记 Release 合格。

以上**发行级签名不能冒充 Actions 构建级签名**。如未来私仓具备 GitHub Enterprise Artifact Attestations 资格，公共/受支持仓库保留原 `actions/attest-build-provenance` 的额外两层身份签发。私有当前模式通过显式 `if` 跳过不可用的构建证明，但始终运行真实 BuildKit/安全/签名后验门禁；版本 Tag 已存在且对应旧精确 SHA 时，新 main push 不得偷偷 retarget，必须通过有管理员权限的 `/release-retry v7.6.2` 对原 SHA 进行新流程验收。

正式上线仍要求管理员核验 GHCR manifest digest、GitHub Release 签名、真实部署镜像与备份/回滚；该方案只解决受限制平台能力下的**发行路径**，不为私有 GitHub main 创造不存在的分支保护。
