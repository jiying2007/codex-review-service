# 质量平台

Codex Review Service 7.6.2 使用精确固定的 Safe Core 4.18.1：Quality Platform v3、Review Profile Pack v1、Impact Evidence v2、Test Impact v1 与 Analyzer Finding v1。所有质量证据都绑定 MR 不可变 head SHA。仓库内容、CI 报告、Analyzer 文本始终是不可信证据，不是可执行指令。

## Review Profile Pack

`review.profile` 现在是版本化工程 Profile Pack，不再是底层执行档。支持 `general`、`backend`、`frontend`、`security`、`cpp`、`embedded-linux`、`embedded-mcu`、`driver`、`kernel`、`realtime`。Pack 由 Safe Core 解析，并只向首个模型 chunk 加入有界、可信的 Review 关注点；不能授予工具、网络、SCM 写权限，也不能削弱 Safe Contract。

## Analyzer Adapter Hub

当前配置使用 Config Schema 8。历史上，Config Schema 3 删除旧的“仓库内文件” `sarifFiles`，统一改为 `review.analyzerReports`。报告通过 GitLab Job Artifact API 从精确 head pipeline 获取，再由产品侧有界 Adapter 解析。支持：

- SARIF 2.1-compatible JSON；
- GitLab Code Quality JSON；
- JUnit XML；
- Cobertura XML / LCOV Coverage Summary；
- GCC/Clang/MSVC 风格 Compiler Diagnostic；
- Cppcheck XML；
- CycloneDX JSON metadata；
- Trivy JSON；
- Gitleaks JSON。

Finding 类结果统一进入 Safe Core Analyzer Finding Contract，且只有能绑定到真实 changed line 时才可成为可发布 Finding。没有源码定位的 JUnit Failure、Coverage 百分比、SBOM/Vulnerability 数量只作为有界 metadata，不伪造源码问题。配置为 `required` 的报告只要无法证明 head pipeline / job / artifact 完整存在，就 fail closed。

Service 永远不执行仓库定义的 Analyzer 命令；CI 负责真正执行工具，Review Service 只消费已经产生的 Artifact。

## Test Impact v1

开启后，Service 从精确 source-project head SHA 枚举测试文件，把不可变 Test Candidate、changed path 与语义信号交给 Safe Core `buildTestImpactMap()`。Core 确定性排序最可能受影响的测试，并把有界推荐集作为模型证据；它不会执行测试，也不能把“缺少测试结果”包装成成功 Verdict。

`testPathPrefixes`、`maxTestCandidates`、`maxRecommendedTests` 限制发现与上下文规模，默认前缀是 `test/`、`tests/`。

## Impact Evidence

Semantic Impact Candidate 仍只通过 GitLab Repository API 从 MR 精确 head SHA 获取；Core 只对受限 include/import/symbol/build/Kconfig/DeviceTree Evidence 做评分，不自行访问仓库。

## Cross-review Differential Gate

`src/differential-quality.js` 提供一个确定性的离线 Comparator，用于比较两个针对**同一个 exact diff fingerprint** 的规范化审查 Judgment。它不会调用另一个 Reviewer、不会执行模型，也不会让 Codex Review Safe 与 Codex Review Service 形成运行时依赖。

默认阻断边界是 High。当两个 Judgment 都 coverage complete 且绑定同一个 64 位十六进制 diff fingerprint 时，只要另一条审查链也在相同的精确 `file + side + line` causal anchor 上接受了 High/Critical Finding，就视为 High+ 对齐。不同产品可以使用不同 category、文字描述和 claim taxonomy，不会因此制造伪分歧。

High+ anchor 缺失会进一步分类：

- `controller_gate_disagreement`：另一条审查链其实看到了同一 anchor，但被 suppress 或 reject；
- `severity_disagreement`：另一条审查链接受了同一 anchor，但严重级别低于阻断阈值；
- `recall_disagreement`：另一条审查链没有任何对应的 accepted / suppressed / rejected candidate。

不同 diff fingerprint 或任一侧 coverage incomplete 都属于 `inconclusive`，绝不能作为 clean pass。`assertCrossReviewDifferential()` 默认因此对 High+ 分歧以及 inconclusive evidence 都 fail closed。

永久 corpus 位于 `quality/cross-review-corpus.json`，固定覆盖：删除鉴权产生的 old-side High 漏报、controller suppression、severity boundary 分歧、修复后 High+ 对齐、coverage incomplete 与 exact-diff mismatch。

这是质量评估门禁，不是生产运行时 quorum：没有第二份 Judgment Envelope 时，正常 MR Review 仍保持独立可用。

## 人工 Resolution 边界

人工 finding resolution 采用 append-only 历史：`fixed`、`false_positive`、`accepted_risk`、`duplicate`、`obsolete`、`not_applicable`、`policy_exception`。这些反馈只进入可观测指标，绝不会自动训练模型、动态修改 Prompt 或形成自训练闭环。
