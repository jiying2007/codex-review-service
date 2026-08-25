# Product Contract

`product-contract.json` is the machine-readable source of truth for Codex Review Service compatibility and release identity. Runtime constants, configuration examples, release metadata, Docker labels, Doctor output and governance tests must match it.

Service v5.0.0 freezes Database Schema 5 and Config Schema 1 as the first supported production contracts. Future schema changes require explicit migration fixtures, forward-upgrade tests and a documented rollback boundary; pre-release hard-cut recreation must not be reused as a normal upgrade strategy.

Safe Core remains exact commit-pinned and owns shared review protocol semantics. Service-only deployment, notification, Admin/DR and OCI concerns must not modify that shared boundary.
