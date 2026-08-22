## Summary

Describe the production behavior changed by this PR.

## Safety / reliability checklist

- [ ] Webhook acknowledgement durability is unchanged or improved.
- [ ] No GitLab secret can enter the Codex child environment.
- [ ] Stale `start_sha` / `head_sha` results cannot publish.
- [ ] Provider/API partial failures are retryable or fail closed.
- [ ] Publication is idempotent and does not cause Codex re-execution.
- [ ] Merge-gate behavior is deterministic.
- [ ] No source diff, prompt, raw model output, or credential is added to persistent logs.
- [ ] Schema changes are additive/migratable and tested from the previous released schema.
- [ ] Node 22.13 and Node 24 CI pass.
- [ ] Operations/README/CHANGELOG are updated when behavior or deployment changes.
