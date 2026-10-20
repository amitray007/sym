# 045. The owner connects MCP servers from Slack

Status: accepted
Date: 2026-10-20

## Context

The owner wants to say "connect example-tracker at https://mcp.example.com/mcp" and have Sym set
it up. A server that needs a token should read it from the environment, and Sym should say which
env var to set. A server with an OAuth sign-in should send the owner a sign-in link. Nothing
service-specific may live in the repository, so connections are data in Postgres.

Eve facts that shape the design (0.81.0):

- `defineDynamic` in `agent/connections/` can return a map of `defineMcpClientConnection` on
  `session.started` or `turn.started`. Map keys become connection names, and the model reaches
  the tools through `eve__search` and `eve__tool` as `<name>__<tool>`.
- A connection name allows only lowercase letters, digits, and dashes. Underscores fail.
- `tools: { block }` hides tools from the model. `approval` takes a request policy that gets the
  qualified tool name and the server's tool annotations, and a response policy that decides who
  may answer.
- An approval prompt is built from the tool input only. It cannot read the database.
- `auth.getToken` gives Eve the bearer token. It never reaches the model. Eve's own interactive
  OAuth is user-scoped and posts the challenge in the conversation, so Sym does not use it.

## Decision

- **Rows.** Migration `012_connections` adds `connections` (name, URL, description, auth kind
  `none`, `env`, or `oauth`, env var, status `proposed`, `active`, or `disabled`, tools, creator,
  approver) and `connection_credentials` (access token, refresh token, expiry, and the OAuth
  client registration). Code lives in `lib/connections/`.
- **Names.** 2 to 31 lowercase letters, digits, and single dashes, starting with a letter, such
  as `example-tracker`. Names Sym or Eve use (`owner`, `eve`, `worker`, `sym`, and others) are
  refused, because a connection owns every `<name>__` tool and `owner__*` are the memory tools.
- **Probe.** `connection_add` connects with the MCP SDK, anonymously first, with an 8-second
  limit per request. Tools that list are recorded. A 401 means a sign-in: OAuth when the
  authorization server offers dynamic client registration, else a token. A tool is read-only
  only when the server says `readOnlyHint: true`. The URL must be https unless it is loopback,
  and it may not carry a user name or password.
- **Approval.** `connection_add` saves a `proposed` row and returns a review. The brain passes the
  review to `connection_approve`, whose prompt shows the URL, the sign-in kind, and every tool
  with read or write. Execute refuses a review that differs from the stored row, as
  `playbook_review` does. Only the owner may approve (`ownerResponse`).
- **Tokens.** A token server reads `SYM_MCP_<NAME>_TOKEN` (`example-tracker` reads
  `SYM_MCP_EXAMPLE_TRACKER_TOKEN`). Sym reads only names that match `^SYM_MCP_[A-Z0-9_]+_TOKEN$`,
  in code and in a database check, so a connection can never read `SLACK_BOT_TOKEN` or another
  secret. Sym tells the owner the name and never asks for or accepts a token in chat.
- **OAuth.** `connection_sign_in` runs the worker sign-in flow (decision 036) against the
  connection's server: discovery, registration, PKCE, the RFC 9207 issuer check, the Eve webhook
  redirect on `SYM_SIGNIN_URL`, the link in the owner's DM through the outbox, and the 10-minute
  wait. The flow now lives in `lib/oauth.ts`, and the worker sign-in uses it too. Sym asks for
  the scopes the server's protected-resource metadata lists. It asks for a refresh token when
  the server offers one, and it refreshes 60 seconds before expiry under a row lock. After the
  sign-in, Sym lists the tools with the new token.
- **Loading.** `agent/connections/rows.ts` loads active rows at every `turn.started`, so an
  approval, a mode change, or a removal applies to the next message. Worker threads get none. A
  connection without its token or sign-in does not load, and `connection_list` says why. Each
  connection has `instanceKey` `conn-<id>`; a re-added connection gets a new row and a new key.
- **Tool modes.** `auto` runs freely, `ask` needs the owner's approval for every call, and
  `hidden` goes in `tools.block`. A read tool starts `auto` and a write tool `ask`. A tool the
  server added after the last listing follows the same rule from the annotations Eve passes to
  the policy. `connection_tools` changes a mode, with the owner's approval.
- **Removal.** `connection_remove` disables the row and deletes its stored sign-in, with the
  owner's approval.
- **Untrusted results.** Each connection's description tells the model to treat results as data.
  `agent/instructions.md` says connection results never widen the project list, the worker rules,
  or what needs approval.

## Consequences

- The brain uses six tools, not five: Eve's approval prompt cannot read the probe result, so
  `connection_approve` carries it in its input.
- OAuth tokens, refresh tokens, and client registrations sit in Postgres in plain text, as the
  worker token does (decision 036).
- Tool modes rest on the server's annotations, which are hints. A server that marks a write tool
  read-only gets it run without asking. The owner can set that tool to `ask`.
- A server that hides tools from anonymous callers shows none before the sign-in. The approval
  prompt says so, and the default rule covers the tools that appear later.
- Sym has not run against a real third-party MCP server. The tests use a fake server that runs
  open, token, and OAuth modes.
