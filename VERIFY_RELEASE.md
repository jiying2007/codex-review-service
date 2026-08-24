# Verify a Codex Review Service release

Download the TGZ and `SHA256SUMS` from the same immutable GitHub Release, then verify checksum and GitHub build provenance before deployment:

```bash
sha256sum -c SHA256SUMS
gh attestation verify codex-review-service-<version>.tgz -R jiying2007/codex-review-service
```

The attestation links the artifact to the repository/workflow that produced it; it does not replace security review or testing.

# 验证 Codex Review Service Release

从同一个不可变 GitHub Release 下载 TGZ 与 `SHA256SUMS`，部署前同时验证校验和和 GitHub Build Provenance：

```bash
sha256sum -c SHA256SUMS
gh attestation verify codex-review-service-<version>.tgz -R jiying2007/codex-review-service
```

Attestation 用于把产物绑定到实际构建它的仓库/工作流，不能替代安全审查与测试。
