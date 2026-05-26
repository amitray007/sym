# FUTURE.md

## Collapse — 2026-05-27

On 2026-05-27 the Sym monorepo was collapsed to a single deployable: `apps/agent`
— a Hono server that receives Slack events, runs one Pi-agent AI loop (Fireworks,
OpenAI-compatible), and replies in Slack. Configured entirely by environment
variables. No database, no dashboard, no persistence beyond the live Slack thread.

The following were removed and can be restored from git history if revisited:

- **Connectors** — MCP HTTP tool registry (`packages/ext/mcp`, `packages/ext/skills`)
- **Skills** — skill loader + activation
- **Audit** — hash-chained audit log + receipts (`packages/audit`)
- **Dashboard** — Next.js admin control plane (`apps/dashboard`)
- **Database / persistence** — Drizzle schema + Postgres (`packages/db`)
- **Secrets** — libsodium encrypt/decrypt (`packages/secrets`)
- **Tasks** — durable queue + checkpointing (`packages/tasks`)
- **Provider package** — extracted Fireworks adapter (`packages/provider/fireworks`);
  the provider is now called inline in the agent
- **Memory engine** — five-scope semantic memory (`packages/memory`)
- **Soul engine** — configurable voice/personality cascade (`packages/soul`)
- **Sandbox** — Docker+gVisor per-turn isolation (`packages/sandbox`)
- **Kernel package** — thin agent loop abstraction (`packages/kernel`);
  replaced by the Pi agent SDK directly in `apps/agent`
