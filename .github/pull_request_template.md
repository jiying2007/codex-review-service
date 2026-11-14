## Summary

Describe the production behavior changed by this PR.

## Safety / reliability checklist

- [ ] Webhook acknowledgement durability is unchanged or improved.
- [ ] No GitLab secret can enter the Codex child environment.
- [ ] Stale `start_sha` / `head_sha` results cannot publish.
- [ ] Provider/API partial failures are retryable or fail closed.
- [ ] Publication is idempotent and does not cause Codex re-execution.
- [ ] Merge-gate behavior is deterministic.
- [ ] Project-fair scheduling preserves same-MR serialization and bounded retry/poison-job behavior.
- [ ] Isolated Runner capability negotiation remains fail-closed against Safe Core / Contract / Receipt / Prompt drift.
- [ ] Finding lifecycle remains derivable as `new` / `persistent` / `resolved` / `regressed` from durable run/finding history.
- [ ] No source diff, prompt, raw model output, or credential is added to persistent logs.
- [ ] Schema changes are additive/migratable and tested from the previous released schema.
- [ ] Safe Core pin, runtime contracts and product metadata remain consistent.
- [ ] Release assets remain immutable and include TGZ, SPDX SBOM, SHA256SUMS and provenance attestation.
- [ ] Declared Node 22/24 CI and affected platform qualification pass.
- [ ] Operations/README/CHANGELOG are updated when behavior or deployment changes.
