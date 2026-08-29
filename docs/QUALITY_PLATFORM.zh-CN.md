# 质量平台

Codex Review Service 6.2 使用 Safe Core 4.8 的 Quality Platform v2、Review Profile Pack v1、Impact Evidence v2、Test Impact v1 与 Analyzer Finding v1。所有质量证据都绑定 MR 不可变 head SHA。仓库内容、CI 报告、Analyzer 文本始终是不可信证据，不是可执行指令。

## Review Profile Pack

`review.profile` 现在是版本化工程 Profile Pack，不再是底层执行档。支持 `general`、`backend`、`frontend`、`security`、`cpp`、`embedded-linux`、`embedded-mcu`、`driver`、`kernel`、`realtime`。Pack 由 Safe Core 解析，并只向首个模型 chunk 加入有界、可信的 Review 关注点；不能授予工具、网络、SCM 写权限，也不能削弱 Safe Contract。

## Analyzer Adapter Hub

Config Schema 3 删除旧的“仓库内文件” `sarifFiles`，统一改为 `review.analyzerReports`。报告通过 GitLab Job Artifact API 从精确 head pipeline 获取，再由产品侧有界 Adapter 解析。支持：

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

## 人工 Resolution 边界

人工 finding resolution 采用 append-only 历史：`fixed`、`false_positive`、`accepted_risk`、`duplicate`、`obsolete`、`not_applicable`、`policy_exception`。这些反馈只进入可观测指标，绝不会自动训练模型、动态修改 Prompt 或形成自训练闭环。
