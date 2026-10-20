# 049. A connection has a default tool mode

Status: accepted
Date: 2026-10-20

## Context

`connection_tools` set one tool at a time to `auto`, `ask`, or `hidden`. A tool without
`readOnlyHint` starts in `ask`, so each call needed the owner's approval. A gateway-style server
(a few tools such as `search` and `execute`, with its own approvals) cannot be trusted as a
whole, and tools the server adds later start in `ask` again.

## Decision

1. **Resolution order.** Each tool resolves in this order:
   1. the mode the owner set for that tool with `connection_tools` (its own mode),
   2. the connection's `default_mode`,
   3. the annotation rule: read-only is `auto`, anything else is `ask` (decision 045).

   One function, `resolveMode` (`lib/connections/tools.ts`), implements it. The loader, the
   approval policy, `tools.block`, and `connection_list` all call it. A tool Sym has not
   recorded, such as one the server added later or one first seen through Eve's approval request
   policy, has no own mode. It resolves from the connection default, then the annotations passed
   with the call.
2. **Storage.** Migration `014_connection_default_mode` adds `connections.default_mode` (null,
   `auto`, `ask`, or `hidden`, with a check). Null keeps the annotation rule. Own modes stay in
   the `tools` jsonb as an optional `override` on each tool. The old `mode` field held a value
   computed at listing and could not tell an owner's choice from a default. `recordTools` now
   stores only the owner's choice, so changing the default changes every tool without an
   `override`. A relist keeps `override`. A read tool that becomes a write tool loses an `auto`
   override and follows the default again.
3. **Old rows.** A row from before this decision has `mode` and no `override`. `parseTools`
   reads a stored mode that differs from the annotation rule as the owner's choice, and a mode
   that equals it as a default. No data migration runs. The one loss: a read-only tool the owner
   set to `auto` by hand reads as a default, so a later default of `ask` or `hidden` reaches it.
4. **Tool surface.** In `connection_tools`, `tool` is optional. Without it, the call sets the
   connection default. The `mode` value `default` clears: the tool's own mode with a tool, the
   connection default without one. The owner approval (`ownerResponse`) and the in-code owner
   check stay. The prompt for a connection-wide `auto` says: every tool on the connection,
   including tools the server adds later, runs without asking you; the server's own policy is
   then the only gate; tools the owner set one by one keep their mode.
5. **Display.** `connection_list` shows the default mode (or "by tool hints") on each
   connection, and the per-tool view marks tools with their own mode.
6. **Instructions.** `agent/instructions.md` tells the brain to call `connection_tools` without a
   `tool` when the owner says to trust a whole connection or stop asking for it.

## Consequences

- With a default of `auto`, Sym stops gating that server. A hostile or buggy server can run any
  of its tools unasked. Server text still cannot change a mode (decision 048).
- A default of `hidden` blocks tools the server lists now through `tools.block`. A tool added
  later is denied by the approval policy, but the model may still see its name.
- Only the owner can set a default. A worker thread cannot call the tool.
- Not run against a real gateway server. The tests use fakes and the local Postgres.
