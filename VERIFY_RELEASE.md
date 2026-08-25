# Verify a Codex Review Service release

A production release has two canonical delivery forms tied to the same source SHA: the tgz/file artifact set and the GHCR OCI digest.

Download these files from the same immutable GitHub Release:

```text
codex-review-service-<version>.tgz
SBOM.spdx.json
IMAGE_DIGEST.txt
compose.release.yaml
SHA256SUMS
```

Verify file checksums:

```bash
sha256sum -c SHA256SUMS
```

Verify GitHub build provenance for release files:

```bash
gh attestation verify codex-review-service-<version>.tgz -R jiying2007/codex-review-service
gh attestation verify SBOM.spdx.json -R jiying2007/codex-review-service
gh attestation verify IMAGE_DIGEST.txt -R jiying2007/codex-review-service
gh attestation verify compose.release.yaml -R jiying2007/codex-review-service
```

Inspect the canonical image identity:

```bash
cat IMAGE_DIGEST.txt
# ghcr.io/jiying2007/codex-review-service:<version>@sha256:...
```

Verify OCI provenance against the repository:

```bash
image=$(cat IMAGE_DIGEST.txt)
gh attestation verify "oci://${image}" -R jiying2007/codex-review-service
```

Confirm `compose.release.yaml` contains the exact same `image@sha256` value, not a mutable tag:

```bash
grep -F "$(cat IMAGE_DIGEST.txt)" compose.release.yaml
```

For the tgz, inspect the package boundary before installation if required by local policy:

```bash
tar -tzf codex-review-service-<version>.tgz | less
```

Expected release properties:

- immutable Git Tag points to the release source SHA;
- existing release assets are never overwritten;
- package excludes test/scripts/workflow/development-only Safe Core files;
- package SBOM is SPDX JSON;
- OCI image is multi-architecture and produced with BuildKit SBOM/provenance;
- release workflow scans the image and hard-fails on unfixed policy-defined blocking vulnerabilities;
- GitHub provenance binds artifacts/image to this repository/workflow.

Attestation proves build provenance, not semantic correctness. Deployment still requires approved CI/system-test results and operational acceptance.

# 验证 Codex Review Service Release

正式 Release 有两种 canonical 交付物，并绑定同一个源代码 SHA：tgz/文件产物与 GHCR OCI digest。

从同一个不可变 GitHub Release 下载：

```text
codex-review-service-<version>.tgz
SBOM.spdx.json
IMAGE_DIGEST.txt
compose.release.yaml
SHA256SUMS
```

验证文件校验和：

```bash
sha256sum -c SHA256SUMS
```

验证 GitHub Build Provenance：

```bash
gh attestation verify codex-review-service-<version>.tgz -R jiying2007/codex-review-service
gh attestation verify SBOM.spdx.json -R jiying2007/codex-review-service
gh attestation verify IMAGE_DIGEST.txt -R jiying2007/codex-review-service
gh attestation verify compose.release.yaml -R jiying2007/codex-review-service
```

读取 canonical 镜像：

```bash
image=$(cat IMAGE_DIGEST.txt)
echo "$image"
gh attestation verify "oci://${image}" -R jiying2007/codex-review-service
```

确认 `compose.release.yaml` 使用完全相同的 `image@sha256`，而不是 mutable tag：

```bash
grep -F "$(cat IMAGE_DIGEST.txt)" compose.release.yaml
```

需要时可检查 tgz package boundary：

```bash
tar -tzf codex-review-service-<version>.tgz | less
```

Attestation 证明产物来自声明的仓库/工作流，但不能替代代码审查、真实 GitLab 系统测试、漏洞策略和生产验收。
