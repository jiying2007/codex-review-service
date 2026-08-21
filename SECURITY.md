# Security Policy

## Trust boundary

Codex Review Service separates the privileged GitLab controller from the unprivileged Codex review process.

The controller may hold:

- `GITLAB_API_TOKEN`
- `GITLAB_WEBHOOK_SIGNING_TOKEN`
- `GITLAB_WEBHOOK_SECRET_TOKEN`

Those values are never intentionally copied into the Codex child-process environment. Codex receives only a small runtime allowlist plus `CODEX_HOME` and, when explicitly configured, `OPENAI_API_KEY`.

## Untrusted repository data

Merge request titles, descriptions, filenames, diffs, source comments, strings, generated text, and webhook payload fields are untrusted input. They cannot change service policy or grant Codex additional capabilities.

The service does not clone the reviewed repository. It sends bounded textual merge request diffs to Codex and runs Codex in a newly-created empty temporary directory with a read-only sandbox.

## Webhook authentication

For GitLab versions supporting Standard Webhooks signing tokens, the service verifies:

- `webhook-id`
- `webhook-timestamp`
- `webhook-signature`
- HMAC-SHA256 over the exact raw body
- an allowed timestamp skew to reduce replay risk

The `whsec_` signing token is base64-decoded before HMAC computation, and `v1,<base64 digest>` signatures are compared in constant time. Multiple space-separated signatures are supported.

Legacy `X-Gitlab-Token` verification is supported for older GitLab and migrations. If both mechanisms are configured and a signed request is present, HMAC verification takes precedence.

Webhook delivery IDs are persisted with a unique constraint. A delivery that fails before enqueue is removed from the unprocessed ledger so GitLab retry semantics remain intact.

## Stale-result protection

A review is bound to a specific MR HEAD SHA. Before publishing any result, the service re-fetches the merge request and verifies that HEAD is unchanged. A new HEAD aborts an active old review and supersedes queued/running jobs for older HEADs.

## Coverage safety

A merge request is never marked pass if its diff coverage is incomplete. Files reported by GitLab as `too_large` or `collapsed`, unavailable diffs, or files skipped because the configured diff-byte budget was exhausted cause the review verdict to become `incomplete` and the external commit status to fail.

## Finding validation

Model output is locally validated. Findings must:

- use an allowed severity and category;
- reference a changed file;
- meet the configured confidence threshold;
- reference a changed post-change line or a nearby changed line;
- fit bounded title/description/suggestion lengths.

`critical` and `high` findings are deterministically blocking; the model does not control the merge-gate policy.

## Logging

Do not add persistent logs containing source diffs, prompts, raw Codex output, GitLab tokens, webhook secrets, OpenAI credentials, or full sensitive filesystem paths. Operational logs should contain only metadata such as job ID, project ID, MR IID, short HEAD, duration, verdict, counts, and normalized error categories.

## Deployment

Run the service as a dedicated non-login Unix account. Keep `/etc/codex-review-service.env` mode `0600`. The included systemd unit enables `NoNewPrivileges`, a read-only system filesystem, kernel/control-group protections, a private temporary directory, and a narrow writable data directory.

Terminate TLS at a trusted internal reverse proxy and restrict network access to the webhook endpoint to the GitLab instance or trusted ingress whenever possible.

## Reporting

Do not open a public issue containing secrets or exploitable details. Use GitHub's private security reporting facilities for this repository when available.
