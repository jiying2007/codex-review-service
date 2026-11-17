# 审查质量—Token 成本离线门禁（V8）

`node src/review-quality-benchmark.js baseline.json candidate.json [minimumSavingsPercent]`

纯本地、无模型/无 GitLab/无网络的 Baseline/Candidate 比较器。
每个 JSON 输入必须遵守 Schema 1：
```json
{
  "schemaVersion":1,
  "datasetDigest":"<通过 datasetDigest(cases) 计算的 64 位 sha256>",
  "cases":[{
    "id":"case-001","sourceReceiptSha256":"<原始评测回执的 64 位 sha256>",
    "changedFiles":2,"reviewedFiles":2,"coverageComplete":true,
    "expected":[{"id":"verified-defect-001","severity":"high"}],
    "detected":["verified-defect-001"],
    "durationMs":1000,
    "usage":{"known":true,"inputTokens":900,"outputTokens":100}
  }]
}
```
至少六条用例，必须包含高危真实缺陷及负例；Baseline/Candidate 的相同用例需保持
**相同标注数据集**。当存在未知模型用量时禁止宣称省 Token；不能用覆盖完整的布尔值
掩盖未审文件；默认在精确召回和 Precision 不下降、覆盖不下降的情况下，要求 Token
至少节省 5%。输出明确区分 `researchGatePassed` 和恒为 false 的
`productionQualified`，因为**文件中的回执 SHA 格式不等于独立签名或人工真值证据**。
必须用真实执行的 HEAD 绑定评测回执、原始缺陷标注、模型资源指标进一步验证。
该工具不会自动合并 PR 或修改任何生产门禁。
