# Dokploy deployment configuration

Sym runs a single deployable on a Dokploy VPS:

| Deployable | Source       | Port | Framework |
| ---------- | ------------ | ---- | --------- |
| `agent`    | `apps/agent` | 3001 | Hono      |

The agent is configured entirely by environment variables — no database, no
migrations, no Redis required.

## Deploy

1. Set all required env vars in Dokploy → App → Environment (see `env-template.txt`).
2. Trigger a deploy. The pre-deploy hook is a no-op; the post-deploy hook
   hits `/health` and fails the deploy if the agent does not respond 200.

## Files in this directory

| File                          | Purpose                                               |
| ----------------------------- | ----------------------------------------------------- |
| `env-template.txt`            | Env var placeholders to paste into Dokploy secrets UI |
| `deploy-hooks/pre-deploy.sh`  | No-op pre-deploy hook                                 |
| `deploy-hooks/post-deploy.sh` | Smoke-tests `/health` after deployment                |
| `apps/agent.yml`              | Dokploy app config for apps/agent                     |
