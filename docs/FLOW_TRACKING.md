# GitLab Flow Tracking

GitLab Flow Tracking is an opt-in, deterministic event domain inside Codex Review Service. It observes selected GitLab CI/CD lifecycle transitions and routes them through the existing durable notification outbox. **It never invokes Codex and consumes zero model tokens.**

## Boundary

Flow Tracking is not a general GitLab administration bot. Supported event families are Pipeline terminal transitions, Merge Request lifecycle, Tag create/delete, and Branch create/delete. Generic issues, wiki events, user/group administration and arbitrary System Hooks remain out of scope.

## Configuration

Config Schema 4 adds `flowTracking`. `enabled` defaults to `false`, so upgrading does not start new notifications. When enabled with omitted sub-options, the conservative defaults are Pipeline `failed`, MR `merge`, `v*` Tag `create`, and Branch tracking disabled. Pipeline refs, sources and job name patterns accept anchored `*`/`?` globs. Job detail mode is `none`, `failed-only`, or `all`.

`flowTracking` decides which GitLab flows are observed. `notifications.routes[].events` independently decides which normalized terminal events reach each Feishu/WeCom route. This keeps event acquisition and delivery routing orthogonal.

Supported notification events:

- `gitlab.pipeline.succeeded` / `failed` / `canceled` / `skipped`
- `gitlab.mr.opened` / `merged` / `closed`
- `gitlab.tag.created` / `deleted`
- `gitlab.branch.created` / `deleted`

## Transition semantics

Every accepted flow update is projected into SQLite `flow_state` using `(project_id, flow_type, external_id)` as the identity. Repeating the same status does not notify. A real transition increments a revision, which becomes part of the notification dedupe key. A retry such as `failed -> running -> failed` therefore produces a second, legitimate terminal event, while duplicate webhooks remain idempotent.

Pipeline non-terminal states can update the projection without notifying. Terminal cards contain the pipeline/ref/status/source/duration and optionally filtered job summaries. No raw logs, job artifacts, diff, prompt, secret or receipt are sent to IM.

## GitLab integration

Keep Merge Request and Note hooks for Review. Enable Pipeline events when Pipeline Tracking is used, Tag Push events for Tag Tracking, and Push events for Branch create/delete Tracking. All events use the same Classic Token (<19.1) or Standard HMAC (>=19.1) authenticated webhook ingress and existing project/group allowlist.

## Ordinary Commit Push tracking

Service 6.5.0 adds optional `flowTracking.commitPush` for ordinary branch updates. It is disabled by default and remains Webhook-only: no diff, commit, or repository API is fetched just to render a notification, and Codex token cost remains zero. Filters include `refs`, `excludeRefs`, `ignoreUsers`, `maxCommits`, `includeMergeCommits`, and `includeCommitMessage`. The default refs are `main`, `release/*`, and `hotfix/*`. One Push Hook produces at most one `gitlab.push.committed` event with bounded commit details; branch create/delete remains owned by `flowTracking.push` and is never double-classified as a commit push.

For migration from a standalone GitLab notification bot, enable GitLab Push events, route `gitlab.push.committed` through `notifications.routes[].events`, validate the target channels, then disable the old bot webhook before stopping the old service.
