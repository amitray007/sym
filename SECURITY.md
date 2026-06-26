# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's [Private Vulnerability Reporting](https://github.com/amitray007/sym/security/advisories/new)
to report confidentially. You will receive an acknowledgement within 48 hours.

If Private Vulnerability Reporting does not work for you, email
**hey@amitray.dev** directly with "Sym security" in the subject line.

---

## Supported versions

Sym is a personal, self-hosted bot. There is no version lifecycle policy.
Security fixes land on `main` and you should run from `main` (or a recent tagged
release). No backport branches are maintained.

---

## Threat model

Sym is a **single-tenant, owner-gated** bot. The primary owner identity
(`SYM_OWNER_SLACK_USER_ID`) controls every privileged action.

### What Sym protects

| Surface                    | Mechanism                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack request authenticity | HMAC-SHA256 signature verification (`SLACK_SIGNING_SECRET`) in `packages/adapter/slack` — all unsigned or replayed events are rejected before any processing              |
| Owner-only access          | `owner-gate.ts` checks the Slack user ID on every `/slack/events`, `/slack/commands`, and `/slack/interactivity` request before the Pi loop runs                          |
| Destructive tool execution | Confirmation buttons (`confirmations.ts`) pause execution and require the owner to click Approve in Slack; `run_cli` can be confirmation-gated via `SYM_CLI_CONFIRM=true` |
| Admin/control plane        | `/admin/*` routes (hot-reload, status) are loopback-only — any non-`127.x.x.x` caller is rejected at the IP level in `server.ts`                                          |
| OAuth token storage        | AES-256-GCM encrypted SQLite database (`credentials.db`); key is `SYM_ENCRYPTION_KEY` (32-byte, owner-provided); file permissions are set to `0600` on creation           |
| SSRF via web tools         | `safe-fetch` in `tools/web.ts` blocks private RFC-1918 and link-local addresses; `response_url` delivery uses an explicit allow-list of Slack CDN origins                 |
| SSRF via MCP transports    | HTTP MCP connectors are validated to require `https://` and reject non-HTTPS URLs at parse time                                                                           |
| Prompt injection           | `slack-guard.ts` runs an LLM guard pass on incoming messages; verdict is `allow` / `block`; always fails open (a guard error never silences a legitimate message)         |

### What is intentionally out of scope

- **Multi-tenancy** — Sym is single-tenant by design. There is no isolation
  between users because there is only one owner.
- **Slack workspace membership** — Sym trusts that your Slack workspace
  membership controls who can DM it. Owner-gate is the second layer.
- **MCP server code** — Sym executes MCP servers as child processes under the
  same identity. The security of a connected MCP server's code is the operator's
  responsibility. Scope new connectors conservatively and avoid `trust: true`
  on connectors that can mutate infrastructure.

### High-value targets for researchers

- Bypassing the owner gate without having `SYM_OWNER_SLACK_USER_ID`.
- SSRF through the web fetch tool, MCP `http` transport, or `response_url`
  delivery despite the allow-list.
- Credential extraction from the AES-256-GCM store without the key.
- Prompt injection that causes Sym to execute a destructive tool without the
  confirmation gate firing.
- Arbitrary code execution via a crafted MCP tool name or tool argument.
