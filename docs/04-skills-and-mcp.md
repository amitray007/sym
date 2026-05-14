# 04 — Skills & MCP

## Scope of this doc

How tools enter Sym. Two paths:

1. **Skills**: first-party + community packages with a manifest,
   versioned, reviewed, executed inside our runtime.
2. **MCPs**: external Model Context Protocol servers connected by
   teams, with their own auth.

Both end up in the toolset the model sees. Both are governed.

## The governance gap in pookie

Pookie lets a user run `/mcp-add <preset>` and immediately have the
tools wired into the model. With `--channel` or `--global` they extend
access. This is fast and great for individuals; it's brittle for
work because:

- Anyone can connect any preset to the workspace without IT/security
  review.
- No version pinning — preset definitions can change under your feet.
- No record of "we approved Linear at v2 but not v3" or "PagerDuty is
  off until we finish the SOC2 audit."
- Custom MCPs (`/mcp-add my-server <url>`) point at arbitrary URLs.

For a team product this needs structure. Sym keeps the speed (one
command to add) but adds gates.

## Skill manifest

A skill is a package with a manifest:

```yaml
name: pr-watcher
version: 1.2.0
display_name: PR Watcher
description: Watches a GitHub PR until it merges or closes, then pings.
authors:
  - acme-platform-team
license: MIT

# What the skill needs to run.
requires:
  - model_capability: tool_use
  - permission: github.read
  - permission: chat.post
  - network_egress:
      - api.github.com
  - background_task: true   # this skill spawns long-running tasks

# Where it executes.
execution:
  kind: in_process        # in_process | mcp | hosted_function
  entrypoint: src/index.ts
  # for mcp: server_url + transport
  # for hosted_function: function_id + region

# Side-effect declarations.
side_effects:
  - posts_messages
  - creates_tasks
  - reads_external: github

# Scopes this skill may write memory to.
memory_writes:
  - personal
  - channel
  # never: team   # explicit denylist

# Optional: a default system-prompt addendum when active.
prompt_fragment: |
  When users mention a PR by URL, offer to watch it.

# UI hints for surfacing in catalog.
ui:
  category: development
  tags: [github, pull-request, automation]
  icon: github
```

The manifest is what admins review. The manifest, not the code, is
the contract.

## Approval lifecycle

```
proposed ─→ under_review ─→ approved (admin signs off)
                       └─→ rejected (with note)
                  ↓
              approved ─→ enabled (admin enables for team)
                                       │
                                       ├─→ scoped to channels (optional)
                                       │
                                       └─→ available_to_all_channels
```

States are durable. Every transition is an audit event.

### Who can do what

- **Any user**: propose a skill (file an entry in the catalog),
  request approval, request a specific version.
- **Channel admin**: enable an already-approved skill in their
  channel.
- **Team admin**: approve / reject / suspend skills, set version
  pins.
- **Sym maintainers**: publish first-party skills to the public
  catalog.

This mirrors how Slack apps are reviewed by workspace admins, but
extends to a richer permission model.

## Versioning

- Skills follow SemVer.
- Teams pin to a major.minor; patches auto-update.
- Major bumps require re-approval (manifest may have changed —
  scopes, side effects, prompt fragments).
- The runtime resolves version at runtime; cached resolutions are
  invalidated on policy change.

## MCP servers as a skill subtype

An MCP server is a skill with `execution.kind: mcp`. Same manifest,
same approval flow. The differences:

- The server URL is part of the install action, with allowed scopes.
- OAuth handshakes happen inside Sym's adapter; tokens are stored
  encrypted per (user, server) or (channel, server) or (org, server)
  depending on the chosen scope.
- Network egress to the server's URL is whitelisted on approval.

### Built-in MCP presets

We ship the popular ones at known-good versions:

- Linear, GitHub, Sentry, Vercel, Stripe, PostHog, Mercury, Axiom,
  Cloudflare, Supabase, Neon, PlanetScale, PagerDuty, Render, Exa,
  Notion, Google Drive, Salesforce, Jira, Confluence.

(Pookie's list is a great starting set. We add Notion/Drive/Jira
because work-mode demands them.)

Each preset is signed and pinned. Teams enable with one command;
admins control approval centrally.

### Custom MCPs

Custom servers are allowed but require admin approval per server
URL. The URL must serve a valid MCP manifest; we validate it on
addition. Token-based auth is supported; OAuth requires us to
register a client.

## Scope model for skills/MCPs

Following pookie's three-level idea but with explicit policy:

- **personal** (default for individual MCP connections like
  GitHub-token-from-Alice).
- **channel** (anyone in this channel can use it; OAuth on behalf of
  the channel admin).
- **team / global** (admin-only to enable; org-wide use).

This is the *use* scope. The *approval* scope is always team-level;
a team admin approves first, then a channel admin enables in a
channel.

### Why two scopes?

Approval is "is this skill allowed in this org at all?" Use is "in
which contexts within the org does it run?" Conflating them is
pookie's gap — a user can effectively grant org-wide tool access by
running `/mcp-add … --global`, which in a regulated org is not OK.

Splitting them preserves the speed of "I want Linear right now" for
individuals while gating "Linear is now wired up for the whole org."

## The toolset at runtime

When the runtime assembles the toolset for a turn:

1. Start with **builtins** (memory, scheduling, search,
   slack/teams/discord helpers — see below).
2. Add **approved+enabled skills** for the team where channel/scope
   policy allows.
3. Add **enabled MCP servers** scoped to (user, channel, team).
4. If the toolset is large (>20 tools), enable **lazy tool loading**
   so only the ones the model is likely to use this turn are sent in
   the prompt; the rest can be discovered via a `tool_search`
   builtin.

Pookie's gpt-5.5 deployment uses `deferLoading: true` for the same
reason. We adopt the pattern.

## Builtins (always available)

A small, opinionated set:

| Tool | Why builtin |
|---|---|
| `remember` / `recall` / `forget` | Memory is core. |
| `task_create` / `task_status` / `task_cancel` / `task_list` | Long-running work is core. |
| `web_search` / `web_fetch` | The public web is a tier-1 source. |
| `code_interpreter` | Numerical answers should be computed, not guessed. |
| `image_generate` | Common workspace ask. |
| `chat_post` / `chat_react` / `chat_create_thread` | Surface helpers. |
| `chat_post_canvas` (where supported) | Long-form output deserves a doc. |
| `channel_history` / `channel_search` / `read_thread` / `read_file` | Searching the workspace is universal. |
| `cron_create` / `cron_list` / `cron_delete` | Lighter than full tasks for simple schedules. |

Each builtin has its own permission gate. `web_fetch`, for instance,
respects a team-level egress allow/deny list.

## Skill SDK

Skill authors get a typed SDK:

```ts
import { defineSkill, types } from "@sym/skill-sdk";

export default defineSkill({
  manifest: { /* loaded from skill.yaml */ },
  tools: {
    pr_watch: {
      input: types.object({
        url: types.string().describe("GitHub PR URL"),
        ping: types.literal("on_merge", "on_close", "both"),
      }),
      execute: async (input, ctx) => {
        // ctx has scoped memory, task service, chat, audit, secrets.
        const task = await ctx.task.create({
          spec: { kind: "pr_watch", input },
          ttlDays: 7,
        });
        return { taskId: task.id, message: `Watching ${input.url}` };
      },
    },
  },
});
```

The runtime injects `ctx` with scoped accessors. The skill cannot
escape its declared `requires:` block; runtime enforces capability
gates.

## Skill marketplace (future)

Aspirational, not v1:

- Public catalog of skills with ratings, install counts, security
  badges.
- Third-party skill authors can submit; we run a review process
  (security scan, manifest sanity, code review for in-process
  skills).
- Per-skill bug bounty.

For v1 we ship a curated first-party catalog and the SDK for
internal team skills. Public marketplace is a v2 conversation.

## Decisions

- **Manifest-first**: skills are defined by manifest; review the
  manifest, not the code, at admin time.
- **Two-tier scopes**: approval (team) + use (personal/channel/
  team).
- **Version pinning** with admin-controlled promotion.
- **MCP = skill with `execution.kind: mcp`.**
- **Capability gates enforced at the SDK boundary**, not by the
  model.
- **Lazy tool loading** when the toolset exceeds a threshold.
- **Builtins curated**; the model never has a tool we can't
  explain to an admin.

## Open questions

- Sandbox model for in-process skills: VM2-style isolation, dedicated
  worker, or wasm? Probably wasm for v2; v1 trusts first-party code
  and a small set of audited contributors.
- Allowed network egress: per-skill manifest, but how do we keep an
  allowlist current? Default-deny with explicit grants on approval.
- Skill conflicts: two skills providing overlapping capabilities
  (two "create issue" skills from different trackers). Disambiguation
  policy lives in the system prompt + manifest tags.
- Skill cost attribution: per-call API costs (Exa search, GitHub
  rate limit consumption) — surface per-skill in cost dashboards.
