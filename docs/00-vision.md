# 00 — Vision

## The one-line pitch

**Sym is an AI teammate that lives in your team's workspace.** Not a bot,
not a search tool — a teammate. It joins channels, has memory and
opinions, owns tasks, talks to other tools on your behalf, and is
accountable for everything it does.

## The north star

A new employee joins your company. In their first week they:

- Get added to channels and DMs by name. Other people @ them.
- Pick up which channels are formal and which are casual without being
  told.
- Remember what they were told last Tuesday when it comes up again on
  Friday.
- Don't repeat confidential information from one channel to people
  who don't have access to it.
- Take on small, repeating work — "watch this PR, ping me when it's
  green," "post the deploy digest every Monday."
- Have a paper trail. You can ask them why they did something, and
  they can show you.

That is the bar. Sym should feel that way — like a teammate who happens
to be very fast at lookups, very patient with repetitive tasks, very
literal about confidentiality, and very honest about what it doesn't
know.

The opposite of this is "a bot you @ for answers." That's a tool. Tools
don't have continuity, don't have opinions, don't take ownership, and
don't get held accountable. Sym is intentionally trying to be more than
that.

## The thesis in five points

### 1. The workspace is the substrate

The team's center of gravity is the chat workspace (Slack today,
Teams or Discord tomorrow). Email, docs, calendars, ticket systems are
all referenced from chat. Any AI teammate that lives outside that
substrate is asking the team to context-switch to it. Sym lives
inside the substrate and reaches *out* to the other systems.

This is the opposite of the Glean / Dust / Notion AI model, where you
go *to* the assistant. We meet the team where they are.

### 2. Continuity is the killer feature

A teammate that remembers what was said last week — and what was
decided in a channel they're not currently in — has compounding value.
A teammate that doesn't is a stateless function. The work to build
durable, scoped, audited memory is the work that matters.

We will spend disproportionate effort on memory: how it's scoped, how
it's recalled, how it's redacted, how it's audited, how it's deleted.

### 3. Trust is a system property, not a vibe

In a personal-life assistant you can hand-wave trust. At work you
cannot. We have to be defensible on:

- **Scope discipline.** Memory and content from #execs never leak to
  #general, period.
- **Provenance.** Every claim Sym makes is traceable to a source — a
  Slack message, a doc, a tool call, a remembered note.
- **Auditability.** Admins can see what Sym did, when, why, and on
  whose behalf.
- **Reversibility.** Sym can undo things it did. Side-effectful
  actions require confirmation.
- **Compliance.** SOC2-ready logs, data residency options, retention
  policies, GDPR/DSAR handling.

If we ship a feature that compromises any of these, we eat the cost.

### 4. The agent is the product, not the model

The model is a commodity input. The product is the agent loop, the
tools, the memory, the skills, the routing, the audit layer. We
should be able to swap GPT-5 for Claude or Gemini without changing the
team's experience.

This means we own:

- Prompt assembly and caching strategy.
- Tool dispatch and concurrency.
- Memory retrieval and partitioning.
- Tone calibration.
- Skill execution and sandboxing.
- Observability and audit.

The model just speaks.

### 5. The teammate does *work*, not just answers

Most workspace AI today is Q&A. Sym should be biased toward action:

- "Watch this PR" → a real, durable monitor.
- "Post the weekly digest" → a real scheduled job with content
  generation, not a static reminder.
- "When the deploy alert fires, page the on-call" → a real, observed,
  cancellable workflow.
- "Help me triage these 20 tickets" → a sustained back-and-forth that
  ends with the tickets actually triaged.

Long-running tasks are first-class objects in the system, not an
afterthought bolted onto a Q&A loop.

## What success looks like one year in

- A team using Sym for a quarter cannot imagine doing without it. The
  withdrawal cost is high because Sym holds context they don't want
  to re-establish.
- Sym handles a meaningful chunk of recurring routing work: status
  updates, digests, on-call routing, PR babysitting, ticket triage.
- New hires are onboarded *partly* by Sym — it can answer "where do I
  find X" and "who owns Y" reliably with citations.
- Admins have a clear view of cost, usage, audit trail, and policy
  enforcement. No one is nervous about confidentiality.
- The skill catalog has third-party contributions, reviewed and
  approved by each team's admins before they're enabled.

## What success does NOT look like

- A more talkative version of Slack search.
- A bot people @ when they're bored.
- A productivity tool that loses team-wide context every Monday.
- Anything that requires a separate "AI workspace" tab.
- Anything where the audit answer to "why did Sym do that?" is
  "the model decided."

## The "teammate" test

When making a design decision, ask: *would a thoughtful new teammate
do this?*

- Would a thoughtful teammate forward a message from #execs to
  #general? No → Sym doesn't either.
- Would a thoughtful teammate make a guess and say "I think this is
  right"? Yes → Sym should too, with explicit hedging.
- Would a thoughtful teammate take an irreversible action without
  asking? No → Sym confirms first.
- Would a thoughtful teammate say "I'm not sure, let me find out"?
  Yes → Sym should too, instead of confabulating.
- Would a thoughtful teammate randomly speak up in #general at 3am?
  No → Sym has a proactivity policy.

This test is the cheapest correctness check we have. Lean on it.

## Decisions

- **Codename: Sym.** Final product name TBD.
- **Primary surface: chat workspace.** Slack first.
- **Model-agnostic.** Default to Claude or GPT; swappable per
  deployment.
- **Hosted + self-hosted.** Hosted for fast iteration; self-hosted
  available for regulated industries (this affects scheduling and
  storage choices, see `02-architecture.md`).
- **Trust > capability.** Where they conflict, trust wins. We'd
  rather ship a narrower agent that's safe than a broad one that
  leaks.

## Open questions

- Single-tenant vs multi-tenant for the hosted offering — implications
  for cost attribution and noisy-neighbor isolation.
- Naming: do we keep "Sym" or rebrand once the product takes shape?
- Pricing model: per-seat, per-team, usage-based, or hybrid? Strongly
  affects what budget-control features we need to ship in v1.
