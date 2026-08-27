# Quality Platform

Service 5.2 consumes Safe Core 4.4 review profiles, Impact Evidence and SARIF normalization. Profiles are operator execution preferences, not repository policy. Impact candidates come from the exact MR head SHA through GitLab repository APIs; SARIF files must already exist in the repository at that same SHA. The Service never executes repository-defined analyzer commands.

Human finding resolutions are append-only operational feedback (`fixed`, `false_positive`, `accepted_risk`, `duplicate`, `obsolete`, `not_applicable`, `policy_exception`). They are observable metrics only and never auto-train a model or mutate prompts.
