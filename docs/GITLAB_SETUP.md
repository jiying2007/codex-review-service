# GitLab setup

1. Create a Group or Project Access Token with only the API permissions required by Codex Review Service.
2. Configure Project IDs and/or Group IDs in `config.json`.
3. Configure a GitLab 19.1+ Standard Webhooks Signing Token and set the same value as `GITLAB_WEBHOOK_SIGNING_TOKEN`.
4. Add webhook URL `https://<host>/webhooks/gitlab` with **Merge request events** and **Note events**.
5. Run `npm run doctor`, then verify `GET /health/ready`.
6. Create or update a test MR and confirm GitLab status, summary, and discussions.
7. If IM notifications are enabled, verify the expected Feishu/WeCom route receives its deterministic card.
