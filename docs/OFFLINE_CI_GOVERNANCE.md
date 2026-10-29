# Portable offline CI and independent release admission

**Status: opt-in development candidate, NOT an existing Core Family release bypass.**

The private Service currently has no effective native GitHub branch protection; private Ruleset requests return a plan-entitlement 403. GitHub Actions run 40867237748 had 20 failed jobs with zero Runner IDs and zero executed steps. Those records do not prove code quality. Use a separate ephemeral CI runner instead of requiring payment to continue ordinary PR testing. Do not claim optional GitLab Free approvals are enforced.

## Levels and fail-closed rules

- Development: genuine syntax and offline-unit logs signed by a trusted independent CI principal; reviewer signature optional.
- Production: genuine syntax, offline-unit, security, migration, provider, and image suites **plus** an independent current-HEAD reviewer signature over the exact signed CI receipt. This is mandatory for auth, Webhook, SQLite, credential, release and production changes.
- Native multi-GitLab production uses the stricter production-multi mode, additionally requiring the actual multi-offline suite. Unlike development, both production modes require the fixed root-owned trust file and separate reviewer signature.
- Missing/failed/duplicate suites, altered or missing logs, expired evidence, wrong 40-hex SHA, untrusted keys, old approval, same author/reviewer or self-selected trust root fail closed.
- The included no-model test collector can produce ONLY syntax, offline-unit, migration and the multi-offline suite when #116 test files exist. It **does not** produce genuine security/CodeQL, GitLab provider integration or image/OCI proof. Those require actual independent tests on a separate trusted CI system, with raw logs and SHA binding. Never append fake entries to a receipt. **No current production candidate is qualified by this script alone.**

The offline suite is not GitHub branch protection. A free private repository can still merge without a server-enforced Ruleset; the publisher must separately refuse an unauthorized commit/artifact. Existing Core six-repository Ruleset and trusted-release controls remain unchanged unless reviewed and approved in a separate Core governance proposal.

## Protected keys and signed evidence

The protected publisher installs /etc/codex-review/release-trust.json with mode 0644 or tighter, regular non-symlink, owned by root on Linux. Do NOT generate this trust root from PR content or allow PR authors to replace it. Its format is:

    {
      "schemaVersion": 1,
      "repository": "jiying2007/codex-review-service",
      "maxAgeHours": 72,
      "ci": {"keyId":"ci-key", "allowedIdentities":["ci-operator"], "publicKeyPem":"<public Ed25519 SPKI PEM>"},
      "review": {"keyId":"review-key", "allowedIdentities":["independent-reviewer"], "publicKeyPem":"<different public Ed25519 SPKI PEM>"}
    }

These are PUBLIC keys only. Keep the separate CI and reviewer PRIVATE Ed25519 keys in different protected users/machines, mode 0600, inaccessible to test jobs. A reviewer must not equal the PR author. The production verifier CLI accepts ONLY the fixed /etc/codex-review/release-trust.json path, so it cannot select a public key introduced by the PR itself. Key changes need a separately reviewed administrator action.

## Run real offline tests, no Codex/Work/model usage

Use an independently fetched, clean checkout of the exact approved SHA on an isolated test VM/container, **not** production host 192.168.1.22. The collector invokes only hardcoded, no-Codex test commands using shell:false and scrubbed environment variables (no GitHub/GitLab/OpenAI/Codex credentials). It writes an unsigned receipt and raw logs outside the checkout:

    node scripts/collect-offline-ci.js --checkout /work/clean-checkout --output /work/evidence --sha <exact-sha> --author <trusted-pr-author> --issuer ci-operator --runner isolated-linux --suites syntax,offline-unit,migration

An independent CI signer validates the checkout/real logs, then runs a trusted installed signer (never with a private signing key exposed to untrusted PR tests):

The signer CLI independently checks the same raw logs, exact SHA/author/issuer and mandatory suites, and refuses a private key that does not match the administrator-pinned public key. An incomplete or corrupted unsigned receipt cannot be signed as a passing CI receipt.

    node scripts/sign-offline-evidence.js --type ci --mode development --trust /etc/codex-review/release-trust.json --logs /work/evidence/logs --sha <exact-sha> --author <trusted-pr-author> --input /work/evidence/ci.unsigned.json --key /protected/ci-private.pem --key-id ci-key --output /work/evidence/ci.signed.json

Development evidence can be verified immediately, even when GitHub-hosted Actions fail to schedule:

    node scripts/offline-evidence.js verify --mode development --trust /etc/codex-review/release-trust.json --ci /work/evidence/ci.signed.json --logs /work/evidence/logs --sha <exact-sha> --author <trusted-pr-author>

This is evidence for review, not a synthetic GitHub success receipt or auto-merge authorization. Do not edit logs/receipt after signing. The CI signer must independently check that the unsigned results genuinely came from real subprocesses; a cryptographic signature cannot prove that a dishonest signer ran a test.

## Production (not yet wired to release)

After genuine CodeQL/dependency, compatible GitLab provider, migration/recovery and OCI/image verification are completed, a separate reviewer actually reviews the current SHA and evidence and signs:

    node scripts/sign-offline-evidence.js --type review --mode production --trust /etc/codex-review/release-trust.json --logs /work/evidence/logs --ci /work/evidence/ci.signed.json --sha <exact-sha> --author <trusted-pr-author> --reviewer independent-reviewer --key /protected/review-private.pem --key-id review-key --output /work/evidence/review.signed.json

    node scripts/offline-evidence.js verify --mode production --trust /etc/codex-review/release-trust.json --ci /work/evidence/ci.signed.json --review /work/evidence/review.signed.json --logs /work/evidence/logs --sha <exact-sha> --author <trusted-pr-author>

The trusted publisher must authenticate the PR author and SHA independently from the repository, verify the immutable source/artifact digest, ensure neither signer key is controlled by the author, and prevent already-published artifacts from changing. The private production trust root must not be writable by the source author. There is no endorsement here that external evidence and native GitHub Ruleset are equivalent security guarantees.

**This PR does not modify existing release.yml, Core Family release, Service #113/#116 merge controls, Secrets, branch protection, tag publishing or production deployment.** A separately reviewed publishing-adapter PR is needed to enforce this gate before deployment. It must not waive the current six-repository Core Ruleset contract without explicit independent security-policy approval.

## Offline verifier self-tests

    node --test test/offline-evidence.test.js test/offline-collector.test.js

The tests use temporary synthetic keys and logs to verify the validator only, never as real product CI evidence. They reject wrong SHA/signatures, altered logs, missing/failed suites, old receipts, untrusted reviewer/self-approval, insecure private keys and changing the production trust root. Rotated keys need a new key ID and preserved immutable historical receipts. October 2026 restriction on Codex Cloud/CLI and ChatGPT Work shared quota remains active.
