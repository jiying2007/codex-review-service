# Storage and migrations

Schema 6 establishes the production migration framework. Schema 5 upgrades run `integrity_check`, create a mode-0600 SQLite `VACUUM INTO` backup, execute one `BEGIN IMMEDIATE` migration, set `user_version=6`, commit, then run another integrity check. Failure rolls the live DB transaction back and reports the verified backup path. Unsupported historical versions fail closed.

SQLite WAL + FULL remains the only shipped backend. `src/storage.js` is the explicit replacement boundary. HA is recommended only after governed thresholds (over 100 repositories, over 20 Codex workers, over 100k reviews/day, cross-AZ requirement, or zero single-node downtime requirement). PostgreSQL/Redis/Kafka are intentionally not bundled before those requirements exist.
## Schema 10

Schema 10 adds `status_write_attempts` and `status_publication_targets`. Each network send records a durable intent before transport and later records acknowledgement, definite rejection or uncertainty. A target keeps its latest durable job/outbox identity, remote acknowledgement ID, last readback, next check and bounded repair count. No credentials are stored in these tables. Ordinary successful writes retain existing behavior; the status outbox adds `uncertain` for outcomes that cannot be safely called published.

Migration 9 -> 10 is additive and follows the existing integrity check, mode-0600 verified Schema 9 backup, transactional DDL and post-migration integrity check. Versions 5 through 9 retain their sequential upgrade paths. Config Schema 8, status names and the GitLab compatibility floor remain unchanged. Older binaries reject Schema 10; rollback needs a matching release/configuration and verified backup, plus preservation of the current attempt ledger and independent control of outstanding remote writes.

Startup adopts inferable legacy uncertainty without depending on outbox ordering: job generation determines the latest target even when an old job creates its outbox later. A missing job is represented by a null identity and `ELEGACYSTATUSORPHAN`, never an invented generation. A missing complete target retains conservative unknown scope. Legacy history already pruned or overwritten is not reconstructed. Ordinary retry-counter resets cannot remove an adopted uncertainty record.

Unfinished transport intents become unknown on restart. Unknown attempts, their source jobs and the latest desired target are excluded from normal retention deletion. Matching readback does not delete or settle an unknown attempt; only an acknowledged transport whose local completion was interrupted can be completed from exact matching readback when no unknown attempt remains. SQLite backups contain this ledger. Restoring an older backup does not cancel a remotely accepted request. See [commit-status operations](../OPERATIONS.md#commit-status-uncertainty-and-merge-enforcement).

## Schema 9 (historical)

Schema 9 adds `finding_claim_projection` as the current GitLab projection of a known semantic claim and `finding_claim_events` as its append-only lifecycle audit. Review findings persist stable root-cause/class identity, anchor and content digests, and the service-owned note identifier. Migration 8 -> 9 creates and verifies a Schema 8 backup before transactional DDL; rollback requires restoring that backup with the matching Service release. Unknown claims deliberately remain outside the reusable projection.

Claim events are immutable during their configured retention window, not immortal. Both claim events and current projections are pruned using `lifecycle.dataRetentionDays`; deleting an old projection is safe because the publisher falls back to an exhaustive bot-marker scan before creating a replacement discussion.

The notification outbox now observes a publication barrier for final review cards: delivery waits until every same-run GitLab publication is terminal. A bounded 15-minute timeout prevents permanent notification starvation and is rendered explicitly as a degraded publication state rather than a successful publication claim.

## Schema 8 (historical)

Schema 8 adds `review_status_cards`, keyed by Review Job and notification Route. It persists the Feishu application-bot `message_id` and the create/update/fallback state used by durable same-card Review notifications. The notification outbox also gains indexed virtual generated columns for aggregation key/deadline, operation type and status-card Job ID, plus a project/branch/head Review Job index used for bounded MR correlation. Migration 7 -> 8 performs an integrity check, creates and verifies a Schema 7 backup, applies transactional DDL, records `schema_migrations`, and runs a post-migration integrity check. Rollback requires restoring that backup; in-place downgrade is unsupported.

## Schema 7 history

Schema 7 adds `flow_state`, a compact transition projection keyed by project/type/external ID. Migration 6 -> 7 follows the existing integrity-check + verified `VACUUM INTO` backup + transactional DDL process. Old flow state is pruned with normal data retention.

## Publication proof payloads in Service 7.6.2

Status payloads use `statusPublicationProtocol: 1` and bind `jobId`, `startSha` and `statusName` to the durable job and remote target. Schema 10 stores per-transport outcomes separately from mutable outbox retry counters. Writes for the same API URL, status project, SHA, ref and status name share one uncertainty domain even across MRs or when one payload has no explicit pipeline ID.

Finding payloads use `findingPublicationProtocol: 2`. Every create records `findingWriteIntent` in the same durable outbox row immediately before HTTP transport. Known claims bind that intent to the normalized bot identity, claim, finding and exact position; a retry can create only after a fresh complete remote scan under the same identity. Removing or changing the bot identity, or losing known claim identity, never turns a previous create into a first attempt. Recovery and administrative retry preserve this marker. Legacy rows, including protocol 1 rows, with uncertain prior attempts are durably marked and can recover an existing owned discussion, but cannot authorize a blind new create. Protocol 2 failures before transport remain retryable without creating an intent. No prior receipts or historical model findings are promoted to fresh authority.
