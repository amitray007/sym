# 01 — Positioning & differentiators

## TL;DR

The crowded space around Sym splits roughly into three camps:

1. **Workspace assistants** (pookie, Slack AI, Glean, Dust). They live
   in or near the chat workspace and answer questions.
2. **Internal team copilots** (Hermes-style, Atlassian Rovo, custom
   homegrown bots). They live inside the company, glued together by an
   IT team, with deeper enterprise integration.
3. **Vertical workflow agents** (Linear's agents, GitHub Copilot
   workspace agents, Zapier AI). They live inside a single product and
   automate that product's workflow.

Sym is positioned as **#1's surface area, #2's trust posture, and
#3's bias toward doing work rather than answering questions.**

The phrase to remember: *a teammate, not a tool.*

## The five differentiators that matter

These are the things we'd put on the homepage. Each one is hard
enough that competitors can't trivially copy it.

### 1. Per-channel tone calibration

Pookie picks one of three workspace personalities. Sym calibrates per
channel and per audience, with the workspace setting as a floor.

A message in #execs gets professional register. A reply in #eng-banter
gets casual register. A DM with a customer gets formal register. The
*content* is the same — the wrapper changes. This matters at work
because tone is *signal*: an exec reading a Slack response from an AI
that opens with "yo" reads it as low-quality even if the content is
correct.

Details: `06-tone-and-formality.md`.

### 2. Durable, resumable tasks

Pookie has a `cron_create` tool. That fires a prompt on a schedule.
Sym has a Task service: long-running, stateful, resumable work
objects with their own lifecycle, observability, and cancel.

- "Watch PR 1234 until it merges or 7 days pass; ping me on either."
- "Track our Q3 OKRs. Once a week summarize progress in #leadership
  and DM each owner who hasn't updated."
- "Wait for the production deploy to finish, then run the smoke
  tests, then post results."

These are tasks, not crons. They have state, they're observable, and
the same agent loop that started them can inspect them later.

Details: `05-tasks-async.md`.

### 3. End-to-end privacy receipts

Pookie partitions memory by scope (user / channel / global) and
trusts the model not to leak across scopes. Sym enforces the
partition at the retrieval layer (the model can't see what isn't
queryable) and attaches a *privacy receipt* to each response.

A receipt looks like:

```
sources used:
- channel memory from #payments (your channel, 2 notes)
- web search: stripe.com/docs/disputes (1 page)
- thread above (5 messages)
- no personal memory recalled
```

This is visible to the user. Anyone can verify what fed the response.
Admins can audit at the action level: which scope was read, when, by
whom.

Details: `07-permissions-privacy.md`, `09-observability.md`.

### 4. Skills as governed, versioned artifacts

Pookie lets users add MCP servers with slash commands and scope flags
(`--channel`, `--global`). That's frictionless but unreviewable.

Sym ships a **Skill Registry**:

- Each skill has a manifest (name, version, scopes required, side
  effects declared, model requirements).
- Skills are reviewed by team admins before becoming available.
- Versions are pinned per team. Updates require explicit promotion.
- Custom skills can be authored against a typed SDK and reviewed
  via PR.
- The catalog is searchable; users can request approvals.

This trades some friction for accountability — a worthy trade at
work.

Details: `04-skills-and-mcp.md`.

### 5. Cross-platform identity continuity

Pookie is Slack-only. Sym's identity model is platform-agnostic from
day one:

- A user is identified by an organization identity (SSO, SCIM-provisioned,
  email), not a platform user ID.
- Memory is keyed to the org identity, not the Slack/Teams user.
- When the team adds Sym to Teams alongside Slack, the same person
  has the same memory, the same tasks, the same skills.

Slack-only at launch, but the data model never assumes a single
platform. The platform adapter pattern (`08-platform-adapters.md`)
exists so we can extend without rewriting.

## Differentiation matrix

| Capability | Pookie | Slack AI | Glean | Dust | Hermes-style | Sym |
|---|---|---|---|---|---|---|
| Lives in chat (Slack) | ✅ | ✅ | partial | partial | ✅ | ✅ |
| Multi-platform chat | ❌ | ❌ | ✅ | ✅ | varies | ✅ (planned) |
| Per-channel tone | ❌ (workspace) | ❌ | ❌ | partial | ❌ | ✅ |
| Long-running tasks | cron only | ❌ | ❌ | partial | varies | ✅ first-class |
| MCP / skill ecosystem | ✅ | ❌ | partial | ✅ | varies | ✅ governed |
| Skill governance | ❌ | n/a | partial | partial | varies | ✅ |
| Privacy receipts | ❌ | ❌ | partial | ❌ | ❌ | ✅ |
| Scoped memory | ✅ (3 scopes) | ❌ | ❌ | partial | varies | ✅ (typed scopes) |
| Cross-scope leak prevention | trust-based | n/a | n/a | partial | varies | enforced |
| Audit log | partial (Axiom) | partial | ✅ | partial | varies | ✅ first-class |
| Self-host option | ✅ | ❌ | ❌ | ❌ | n/a | ✅ |
| Open source | ✅ FSL | ❌ | ❌ | partial | n/a | ✅ (planned) |

The empty cells in the Sym column are where this doc collapses into
optimism. Earning every ✅ takes real work.

## What we are *not*

Saying yes to a sharp position means saying no to adjacent positions.
We're not:

- **Not an enterprise search engine.** Glean does that. We'll integrate
  with Glean if you have it. We won't try to replace it.
- **Not a coding agent.** GitHub Copilot, Claude Code, Cursor do that.
  We'll talk to them via MCP. We won't compete on code editing.
- **Not a customer-support deflection bot.** Intercom, Ada, etc. We can
  be invited into a support channel to help the team, but we don't sit
  on a website.
- **Not a no-code workflow builder.** Zapier, n8n. We can call them
  via MCP. We won't ship a DAG editor.
- **Not a meeting summarizer alone.** Otter, Fireflies. We can ingest
  their outputs, but we don't compete on transcription.
- **Not a CRM agent.** Same logic.

The point is: Sym is a generalist *teammate*, and the way it gets
leverage is by talking to the specialists. The wedge is the workspace
substrate plus trust plus continuity. The wedge is not "we do
everything."

## When someone says "isn't this just X?"

Likely comparisons and the one-line rebuttal:

- **"Isn't this just pookie?"** Pookie is Slack-only, workspace-level
  personality, scope-tagged memory the model is trusted to honor, cron
  as the only async primitive. Sym is multi-platform-ready, per-channel
  tone, retrieval-enforced scoping, durable tasks, and skill
  governance. Same workspace substrate, different ambition.
- **"Isn't this just Slack AI?"** Slack AI is search/summarize on
  Slack's own data, single tenant, no third-party tool ecosystem, no
  durable tasks, no memory. Sym is an agent with memory, tools, and
  ownership; Slack is one platform we run in.
- **"Isn't this just Glean?"** Glean is enterprise search across
  systems with an answer layer. It does not act, it doesn't have
  per-channel persona, it doesn't run tasks. Sym does work; Glean
  answers questions.
- **"Isn't this just Dust?"** Dust is closer — agent platform, builds
  with tools and data sources. Dust is a builder's surface; Sym is the
  finished teammate that *uses* a builder-style skill registry
  underneath. Different audience and different default UX.
- **"Isn't this just a Slack bot Bob in IT can write?"** Bob's bot
  doesn't have scoped memory, audit, governance, or multi-platform
  continuity. Bob's bot is fine until someone @-replies in #execs and
  it pulls context from #general. That's the moat.

## Decisions

- **Position: AI teammate, not AI tool.** Anchored on continuity,
  trust, and bias to action.
- **Wedge: workspace substrate + privacy receipts + durable tasks.**
- **Hold the line on scope.** Talk to specialists via MCP; don't try
  to be a specialist.
- **Bias against feature parity.** Pick three things we do better
  than anyone and let everything else be "good enough."

## Open questions

- Pricing leverage: does the privacy/audit story let us go up-market
  (security-buyer), or is the wedge mid-market team-buyer?
- How loud do we get about the limits — "not a coding agent" — in
  marketing? Too quiet and we attract the wrong users; too loud and
  we look defensive.
