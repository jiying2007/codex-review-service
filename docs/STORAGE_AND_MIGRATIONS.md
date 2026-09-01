# Storage and migrations

Schema 6 establishes the production migration framework. Schema 5 upgrades run `integrity_check`, create a mode-0600 SQLite `VACUUM INTO` backup, execute one `BEGIN IMMEDIATE` migration, set `user_version=6`, commit, then run another integrity check. Failure rolls the live DB transaction back and reports the verified backup path. Unsupported historical versions fail closed.

SQLite WAL + FULL remains the only shipped backend. `src/storage.js` is the explicit replacement boundary. HA is recommended only after governed thresholds (over 100 repositories, over 20 Codex workers, over 100k reviews/day, cross-AZ requirement, or zero single-node downtime requirement). PostgreSQL/Redis/Kafka are intentionally not bundled before those requirements exist.
## Schema 8

Schema 8 adds `review_status_cards`, keyed by Review Job and notification Route. It persists the Feishu application-bot `message_id` and the create/update/fallback state used by durable same-card Review notifications. The notification outbox also gains indexed virtual generated columns for aggregation key/deadline, operation type and status-card Job ID, plus a project/branch/head Review Job index used for bounded MR correlation. Migration 7 -> 8 performs an integrity check, creates and verifies a Schema 7 backup, applies transactional DDL, records `schema_migrations`, and runs a post-migration integrity check. Rollback requires restoring that backup; in-place downgrade is unsupported.

## Schema 7 history

Schema 7 adds `flow_state`, a compact transition projection keyed by project/type/external ID. Migration 6 -> 7 follows the existing integrity-check + verified `VACUUM INTO` backup + transactional DDL process. Old flow state is pruned with normal data retention.
