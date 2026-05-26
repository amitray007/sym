# FUTURE.md — parked features

Sym was intentionally stripped back to a strong core so those pieces can be made
excellent before the advanced capabilities return. The core we're perfecting:

1. **Slack adapter** (`@sym/adapter-slack`)
2. **AI provider — Fireworks** (`@sym/provider-fireworks`)
3. **Connectors** — MCP (HTTP today; CLI later) with skills
4. **Skills** (with/without connectors)

Memory, Soul, and Sandbox were built early (S6/S7) but never wired into the turn
loop. They're weight on an unproven base, so they're parked here.

## How to restore

Each feature was removed in a **single commit** on `refactor/strip-to-core`. That
commit is the restore pointer:

- `git show <sha>` — see exactly what was removed.
- `git revert <sha>` — bring the code back.

**Restoring the DB:** each removal added a `DROP TABLE` migration. Reverting the
code restores the Drizzle schema; then run `pnpm db:generate` to produce the
inverse (re-create) migration and `pnpm db:migrate` to apply it. Because these
features were never wired into the loop, "restore" also means finishing the
wiring that was never done.

---

## Sandbox / egress proxy — removed in `282761c`

**What it was:** `packages/sandbox` — per-turn credential isolation: a Docker+gVisor
sandbox runner, an egress proxy that injects provider tokens via short-lived JWT,
a lease store/issuer, and the `leases` table. The intended way to safely run
CLI/stdio tools.

**Why parked:** never wired — `@sym/sandbox` was imported nowhere, and CLI/stdio
connectors aren't enabled (only HTTP MCP). It's the prerequisite for safe CLI
connectors, so it returns when CLI tools do.

**Restore:** `git revert 282761c`. Re-create `leases` (inverse migration). Re-add
the sandbox contract types (`SandboxIdentity`, `LeaseRef`, `ToolRuntimeContext.sandbox`).
Wire the lease issuer + egress proxy into the tool-dispatch path (never built).

**Inert residue left in place:** `audit_actor_kind` enum still has `'sandbox'`;
`mcp_transport` enum still has `'stdio'`; the dashboard activity feed still has a
`sandbox` display category. All harmless — clean up when sandbox returns.

---

## Memory engine — removed in `04d9f90`

**What it was:** `packages/memory` — the five-scope semantic memory subsystem
(workspace / channel / thread / dm / custom_relational), a retrieval gate
enforcing per-scope visibility, a change-policy classifier, a consent workflow,
and the `memory_entries` table.

**Why parked:** never wired — the kernel loop literally commented "memory not yet
wired (0 hits)"; nothing retrieved or wrote memories.

**NOT removed (still core):** the conversation transcript (`conversations` /
`messages` tables + `apps/agent/src/persistence.ts`) — the multi-turn chat history
a DM needs. That is distinct from semantic memory and stays.

**Restore:** `git revert 04d9f90`. Re-create `memory_entries` (+ its 3 enums:
`memory_scope`, `memory_status`, `subject_consent_status`). Optionally re-add
`Receipt.memoryHits` / `memoryScopesUsed`. Then wire retrieval into the kernel
loop and writes into the turn lifecycle (never built). Note: with the single-owner
model, the per-scope visibility gate simplifies to owner-only.

---

## Soul engine — removed in `e8ec732`

**What it was:** `packages/soul` — a configurable voice/personality "cascade"
(L0 global → L1 workspace → L2 channel → L3 user), a tone-rewrite stage with a
substance-diff guard, a soul editor data API, and the `soul_layers` table.

**Why parked:** `packages/soul` was dead (imported nowhere); only a hardcoded L0
default was ever used. The kernel prompt was **de-abstracted**: `buildSystemPrompt()`
is now parameterless with the L0 posture inlined as the static `IDENTITY` constant
in `packages/kernel/src/prompt.ts`.

**Restore:** `git revert e8ec732`. Re-create `soul_layers` (+ `soul_layer` enum).
Re-introduce the `SoulCascade` to `runLoop` / `buildSystemPrompt` — or, better,
build cascade resolution as a layer over the current static prompt. The seed for
L0 lives in `prompt.ts` `IDENTITY`.

**Inert residue left in place:** `provider_configs.model_tone_rewrite` is now an
unused column; the `app.soul.update` audit kind was removed.

---

## Separately deferred (not part of this strip)

- **Cross-user grants** — the `grants` table and the `onBehalfOf` / `GrantId`
  plumbing in `@sym/contracts`, `@sym/audit`, and `leases` are kept but inert. It's
  a team delegation feature the single-owner pivot made moot. Revisit only if
  multi-user returns.
- **Provider-config extras** — `provider_configs.model_tone_rewrite` (soul) and
  `model_summarization` (was for memory) are now unused config fields/columns,
  still surfaced in the setup wizard. Clean up when perfecting the provider config.
