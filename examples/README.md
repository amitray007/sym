# Examples

Copy-pasteable starting points for Sym's primary extension surface — **MCP
connectors**.

## `config.json` — a sample connector config

[`config.json`](./config.json) is a sample `.sym/config.json` (the file
`SYM_CONFIG_PATH` points at, default `.sym/config.json`). It defines two
connectors:

- **`sentry`** — a `stdio` connector: Sym spawns the `sentry-mcp` binary and
  authenticates it with a static token, injected into the child process'
  environment as `SENTRY_AUTH_TOKEN`.
- **`example-remote`** — an `http` connector to a remote MCP server that
  authenticates via OAuth (Sym runs the flow and stores tokens in the encrypted
  credential database).

The authoritative schema lives in
[`apps/agent/src/mcp/config.ts`](../apps/agent/src/mcp/config.ts) and is
documented in [`docs/mcp-setup.md`](../docs/mcp-setup.md). Key fields:

| Field            | Meaning                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport.kind` | `stdio` (spawn a local binary) or `http` (connect to a remote MCP server over HTTPS)                                                           |
| `auth.kind`      | `static` (a token you provide), `oauth` (Sym runs the flow), or `ambient` (the wrapped CLI authenticates itself)                               |
| `auth.inject`    | where a static secret is placed: `{ at: "env", name }` or `{ at: "header", name, valueTemplate }`                                              |
| `trust`          | `true` skips the per-call confirmation gate for this connector's tools — only set it for connectors that cannot mutate anything you care about |

> **Never commit real secrets.** Replace `REPLACE_ME` only in your local,
> gitignored `.sym/config.json` — or, better, manage it with
> `sym secret set <connector> <field>` (the encrypted credential store).

## Minimal vs. full setup

- **Minimal** (no connectors): just the core env in the root
  [`.env.example`](../.env.example) — Slack + Fireworks. Sym replies in threads
  with its built-in tools.
- **Full**: also set `SYM_ENCRYPTION_KEY`, drop a `config.json` like this one at
  `SYM_CONFIG_PATH`, then `sym apply` (or `curl -X POST /admin/reload`) — the
  connector's tools become available to the agent in every conversation.
