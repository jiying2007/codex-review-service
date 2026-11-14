# Verify a Codex Review Service release

A production release has two canonical delivery forms tied to the same source SHA: the tgz/file artifact set and the GHCR OCI digest.

Download these files from the same immutable GitHub Release:

```text
codex-review-service-<version>.tgz
SBOM.spdx.json
IMAGE_DIGEST.txt
BUILD_EVIDENCE.json
CONSUMER_CI_RECEIPT.json
compose.release.yaml
OCI_SCAN_TARGETS.json
TRIVY-linux-amd64.json
TRIVY-linux-arm64.json
TRIVY-linux-amd64.sarif
TRIVY-linux-arm64.sarif
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
for file in BUILD_EVIDENCE.json CONSUMER_CI_RECEIPT.json OCI_SCAN_TARGETS.json TRIVY-linux-*.json TRIVY-linux-*.sarif SHA256SUMS; do
  gh attestation verify "$file" -R jiying2007/codex-review-service
done
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
- both platform-specific manifests are scanned with pinned Trivy 0.70.0 and complete package inventories; every Critical and every High with an available fix blocks publication;
- raw JSON and derived SARIF are bound to the OCI index, child manifest/config digests and exact source/version labels through `OCI_SCAN_TARGETS.json` and `BUILD_EVIDENCE.json`, then included in checksums and attestations;
- both Debian 13 platform inventories meet all nine [minimum patched package versions](deploy/docker/README.md#security-baseline), with epoch and revision preserved;
- GitHub provenance binds artifacts/image to this repository/workflow.

Attestation proves build provenance, not semantic correctness. Deployment still requires approved CI/system-test results and operational acceptance.

# 验证 Codex Review Service Release

正式 Release 有两种 canonical 交付物，并绑定同一个源代码 SHA：tgz/文件产物与 GHCR OCI digest。

从同一个不可变 GitHub Release 下载：

```text
codex-review-service-<version>.tgz
SBOM.spdx.json
IMAGE_DIGEST.txt
BUILD_EVIDENCE.json
CONSUMER_CI_RECEIPT.json
compose.release.yaml
OCI_SCAN_TARGETS.json
TRIVY-linux-amd64.json
TRIVY-linux-arm64.json
TRIVY-linux-amd64.sarif
TRIVY-linux-arm64.sarif
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
for file in BUILD_EVIDENCE.json CONSUMER_CI_RECEIPT.json OCI_SCAN_TARGETS.json TRIVY-linux-*.json TRIVY-linux-*.sarif SHA256SUMS; do
  gh attestation verify "$file" -R jiying2007/codex-review-service
done
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

从 7.7.2 起，两种架构的子 manifest 分别接受固定 Trivy 0.70.0 扫描，保留完整安装包清单、原始 JSON 和对应 SARIF。所有 Critical（包括无修复版本）及已有修复版本的 High 都阻断发布；缺失、损坏、过滤过或与镜像身份不符的报告也不能通过。`OCI_SCAN_TARGETS.json` 和 `BUILD_EVIDENCE.json` 将扫描绑定到 OCI index、子 manifest/config 摘要、架构、源码提交及产品版本。两架构的 Debian 13 清单都验证[九个包的最低修复版本](deploy/docker/README.md#security-baseline)，完整保留 epoch 和发行修订号，所有证据纳入校验和及签名。

## SLSA v1.2 Build alignment

Release artifacts are built by hosted GitHub Actions from an exact reviewed commit, checksummed, SBOM-bound and covered by GitHub build-provenance attestations. This documents the Build provenance controls in SLSA v1.2 terms; it does not claim Source L4/two-party governance.
