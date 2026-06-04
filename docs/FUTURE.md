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

Still present (the 4 kept packages): `apps/agent`, `packages/adapter/slack`,
`packages/kernel` (prompt builders + `ToolRegistry`; its old runLoop is retired,
Pi is the only turn path), and `packages/contracts`.

## Rebuilt in-agent since the collapse — 2026-06

The collapse above is dated 2026-05-27. Since then, two capabilities were rebuilt
**inside `apps/agent`** (not as separate services) and are now intended
architecture — not "removed":

- **MCP connectors** — an in-process MCP client (`apps/agent/src/mcp/`) replacing
  the old `packages/ext/mcp`. Static-token and OAuth connectors; the live tool
  pool is reconciled via the operator CLI / `POST /admin/reload`.
- **Operator control tier** — a `sym` CLI with a simple interactive menu
  (`apps/agent/src/cli`) and an **encrypted local SQLite credential store**
  (`apps/agent/.sym/credentials.db`, AES-256-GCM via `mcp/store.ts`) for MCP
  OAuth tokens and static secrets.

So "no database / no dashboard" precisely means **no message database and no
_web_ dashboard** — the Slack thread remains the conversational memory. The
operator CLI and the credential store are a deliberate **local-state control
tier**, distinct from the stateless conversational tier. (The operator CLI runs
in production; the fuller two-tier model is documented in ARCHITECTURE.md.)
