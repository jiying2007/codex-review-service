# Security Policy

## Trust boundary

The privileged controller owns GitLab API/webhook credentials. Codex is a separate child process and never intentionally receives `GITLAB_API_TOKEN`, signing tokens, legacy webhook secrets, or controller-only configuration.

Codex receives a small environment allowlist plus `CODEX_HOME` and optional `OPENAI_API_KEY`. It runs in a fresh empty directory with the Codex Safe Contract: no approval prompts, ephemeral execution, ignored user/repository rules, read-only sandbox, disabled web search, shell/unified execution, apps, multi-agent, remote plugins, hooks, goals, memories, and dependency installation.

## Webhook authentication and scope

The preferred GitLab 19+ path validates Standard Webhooks `webhook-id`, timestamp, HMAC signature over the exact raw body, replay skew, and expected `X-Gitlab-Instance`. Legacy `X-Gitlab-Token` is supported only as a compatibility fallback. Delivery IDs are persisted for idempotency.

`GITLAB_PROJECT_ALLOWLIST` limits accepted project IDs independently of token permissions. Use explicit IDs for the strongest boundary.

Webhook requests perform no GitLab API or Codex work. They authenticate and enqueue locally, allowing fast acknowledgement and limiting request-amplification risk. Body/header sizes and queue depth are bounded.

## Manual command authorization

`/codex review` accepts only newly-created MR comments, ignores the bot itself, and verifies the commenter's effective GitLab membership before spending Codex capacity. Default minimum access is Developer (30).

## Untrusted repository data

MR titles, descriptions, filenames, diffs, source comments/strings, generated files, and model output are untrusted. Repository text cannot grant tools, network, credentials, or override deterministic controller policy.

The optional `.codex-review.json` is read from the target snapshot `diff_refs.start_sha`, not from the unreviewed source branch. Unknown/malformed fields fail closed. Repository policy can only narrow service resource ceilings/refine review emphasis and cannot hide severities blocked by the global gate.

## Snapshot and stale-result protection

A review is bound to both target `start_sha` and source `head_sha`. The service re-fetches the MR before publishing and discards results if either SHA changed. A newer source HEAD aborts an active older review. Periodic reconciliation with explicit project IDs helps recover from missed webhooks and target-snapshot changes.

## Coverage safety

A review cannot pass when GitLab diff pagination is incomplete or a file is unavailable, binary/empty, `too_large`, `collapsed`, larger than the per-chunk byte ceiling, or omitted due to the chunk-count ceiling. Such cases produce `incomplete` and a failed external status.

Codex output is locally validated against exact changed old/new lines. A structurally invalid/unverifiable model finding makes the review incomplete rather than being silently discarded into a false pass. Low-confidence findings below the configured floor are filtered without changing the gate.

## GitLab write safety

The controller, not Codex, creates/updates notes, discussions, resolution state, and external statuses. Stable fingerprints prevent repeated unresolved threads. A human-resolved old finding is not silently reopened; if the problem reappears, a new current-snapshot discussion is created. Only still-unresolved obsolete threads are auto-resolved.

## Storage and logging

SQLite stores only service metadata, review summaries/findings, fingerprints, and GitLab discussion IDs. It does not persist raw source diffs, prompts, raw Codex stdout/stderr, GitLab credentials, OpenAI credentials, or repository checkouts.

Operational logs must remain metadata-only: job ID, project ID, MR IID, short SHA, attempts, duration, normalized error code/status, counts, and lifecycle events. Never add full source paths/content or raw provider responses containing sensitive data.

## Deployment hardening

Run as the dedicated non-login `codex-review` account. Keep `/etc/codex-review-service.env` mode `0600`. The provided systemd unit drops capabilities, enables `NoNewPrivileges`, isolates temp/devices, protects system/home/kernel surfaces, restricts address families, and grants write access only to the state directory and dedicated Codex auth directory.

Terminate TLS at a trusted internal proxy, keep the app on loopback when possible, allow webhook ingress only from GitLab/trusted ingress, and keep health/metrics endpoints on a trusted monitoring network.

## Reporting

Do not publish credentials or exploitable details in a public issue. Use GitHub private vulnerability reporting/security advisories when available.
