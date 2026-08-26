# Core 效率职责

Codex Review Service 将通用 Token 估算、风险评分、自适应预算、模型选择、总字节规划和并发 Token reservation 委托给精确 pin 的 Codex Safe Core。Service 自身只继续拥有 GitLab、SQLite、增量审核状态、changed-path 选择和 finding carry-forward 等产品领域逻辑。
