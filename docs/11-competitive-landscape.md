# 11 — Competitive landscape

## Why this doc exists

A clear-eyed view of who else is in this market, what they do well,
what their structural limits are, and where Sym fits. We will get
this question constantly; this doc is the canonical answer.

The point is not to disrespect competitors. Several are excellent.
The point is to be precise about positioning and to keep ourselves
honest about where they are stronger than us.

## The four categories

We group the landscape into four buckets:

1. **In-chat assistants** — live in Slack/Teams/Discord.
2. **Enterprise search + answer engines** — separate UI, federate
   over your stack.
3. **Agent builder platforms** — let you compose agents and tools.
4. **Vertical workflow agents** — embedded in a specific product.

Sym is in bucket 1, intentionally adjacent to bucket 2, with the
governance posture of bucket 3 and the action-bias of bucket 4.

## In-chat assistants

### Pookie (millionco)

- **Strengths**: Slack-native, fast install, MCP-first, opinionated
  agent loop, open source, well-documented agent code,
  cute/balanced/professional personality.
- **Limits**: Slack-only; workspace-level personality only;
  scope-tagged memory the model is trusted to honor; cron is the
  only async primitive; no skill governance; no receipts; no
  cross-platform identity.
- **Where Sym wins**: tone-per-channel; durable tasks; skill
  governance; privacy receipts; multi-platform-ready data model.
- **Where pookie wins**: time-to-first-install, open-source
  community velocity, charm.

Pookie is the closest peer and the most generous open-source
reference. We borrow patterns explicitly (thread lock, scoped
memory, cron, lazy tool loading).

### Slack AI (Salesforce / Slack)

- **Strengths**: Native, no install friction, deep integration with
  Slack data, no third-party trust step.
- **Limits**: Single platform (Slack only, by definition); no
  third-party tool ecosystem; no durable tasks; no memory beyond
  thread; no audit-grade trace; pricing per Slack seat is steep.
- **Where Sym wins**: tool ecosystem (MCPs, skills); long-running
  tasks; receipts and audit; portable to Teams/Discord; pricing
  decoupled from Slack.
- **Where Slack AI wins**: no install, no admin friction, "just
  there" for Slack users.

### Microsoft Copilot for Microsoft 365 (Teams)

- **Strengths**: Deep Microsoft Graph integration, Teams-native,
  full enterprise sales motion.
- **Limits**: Microsoft-stack-only; agent platform is rigid; no
  Slack/Discord; high price floor.
- **Where Sym wins**: cross-platform; opinionated agent UX vs.
  generic Copilot; per-channel tone; open ecosystem.
- **Where Copilot wins**: in pure-Microsoft shops, the integration
  depth is unbeatable.

### Discord bots (custom / Carl-bot / MEE6 + AI add-ons)

- **Strengths**: Community-managed, low-cost, server-specific
  customization.
- **Limits**: Not work-grade (no audit, no compliance, no memory,
  no enterprise auth).
- **Where Sym wins**: Sym is a work product; the audience overlap
  with these is limited.
- **Where they win**: community / casual server use cases that we
  intentionally don't target.

## Enterprise search + answer engines

### Glean

- **Strengths**: Best-in-class search over the enterprise stack,
  strong permission inheritance, identity resolution at scale,
  excellent answer quality for "find me X" questions, mature audit.
- **Limits**: Separate UI, you go *to* Glean; no action layer; no
  long-running task ownership; no per-channel persona; pricier;
  weaker on chat-native UX.
- **Where Sym wins**: chat-native; bias to action vs. answer; tone
  calibration; durable tasks; lower price floor.
- **Where Glean wins**: enterprise search retrieval quality is its
  whole business; we won't out-search Glean.
- **Coexistence**: Glean is a great upstream. A `glean` MCP would
  let Sym call Glean for retrieval and add the action/continuity
  layer on top.

### Notion AI

- **Strengths**: Excellent for doc-centric work; native to Notion's
  data model; clean UX.
- **Limits**: You have to be in Notion; weak outside-Notion
  integration; no async tasks worth calling tasks.
- **Where Sym wins**: workspace-substrate breadth, not just docs.
- **Where Notion wins**: in Notion-first orgs, the convenience is
  high.

### Atlassian Intelligence / Rovo

- **Strengths**: Deep Atlassian stack integration (Jira,
  Confluence, Bitbucket); enterprise sales motion.
- **Limits**: Atlassian-stack-centric; weaker outside that stack;
  not chat-native.
- **Where Sym wins**: chat-substrate, broader ecosystem.
- **Where Rovo wins**: Jira-heavy orgs.

## Agent builder platforms

### Dust

- **Strengths**: Strong agent-builder model, multi-data-source
  agents, decent governance, French/EU-friendly.
- **Limits**: Builder-centric UX (someone has to build the agent);
  no out-of-the-box workspace teammate; lighter on long-running
  tasks; chat surface is secondary.
- **Where Sym wins**: out-of-the-box teammate experience; chat-
  native; durable tasks first-class.
- **Where Dust wins**: if you want to *build* lots of custom
  agents, Dust's builder is good.
- **Coexistence**: a Dust agent could be wired as a Sym skill via
  MCP.

### Cassidy, Athena, Forethought, and dozens more

- **Strengths**: Varies; usually a strong builder + a few
  vertical templates.
- **Limits**: Mostly builder-first; chat-native and continuity
  story is weak; skill governance varies.
- **Where Sym wins**: opinionated, finished product UX; chat
  substrate; trust posture.

### LangChain / LlamaIndex (as products, not libraries)

- These are mostly developer surfaces. Not direct competition.

## Vertical workflow agents

### Linear Agents

- **Strengths**: First-party, embedded in Linear, automate Linear
  workflows.
- **Limits**: Linear-only.
- **Coexistence**: Sym uses Linear MCP to talk to Linear agents.

### GitHub Copilot Workspace / Agents

- **Strengths**: Deep code context.
- **Limits**: Code-centric; not a workspace teammate.
- **Coexistence**: complementary.

### Zapier AI / n8n AI

- **Strengths**: Strong DAG/workflow editor with AI assistance.
- **Limits**: Not a teammate; not chat-substrate-native.
- **Coexistence**: an `n8n` or `zapier` MCP lets Sym trigger or
  consume their workflows.

### Salesforce Agentforce

- **Strengths**: CRM-vertical depth.
- **Limits**: CRM-vertical.
- **Coexistence**: out of scope unless we go very enterprise.

## Internal homegrown "Hermes-style" bots

These are the bots you find in mid-to-large companies, often built
by an internal platform team:

- **Strengths**: Custom-fit to internal systems; close to the team;
  often have unique internal-tool integrations.
- **Limits**: Maintenance burden, hard to staff, no compliance
  story, no governance, plateau quickly, get abandoned when the
  builder leaves.
- **Where Sym wins**: All the "structural" pieces (memory, audit,
  governance, multi-platform) come out of the box; the team focuses
  on the bespoke skills that differentiate *their* work.

This is one of our biggest pools of converts. We tell them: keep
your internal skills; run them as Sym skills; we take the platform
burden.

## Pricing landscape (rough, not authoritative)

- Slack AI: ~$10/user/month add-on.
- Glean: enterprise; commonly $30-50/user/month.
- Dust: tiered; $29-79/user/month-ish.
- Atlassian Rovo: bundled / add-on.
- Pookie: hosted free-ish (limited managed), self-host free.
- Microsoft Copilot M365: $30/user/month.

Sym pricing space: likely $15-30/user/month for hosted, with self-
host as a separately-priced enterprise license. Final pricing TBD;
see `00-vision.md` open questions.

## Where we'd lose, honestly

- **Pure search quality** at enterprise scale: Glean wins.
- **Pure builder ergonomics**: Dust wins.
- **Pure Microsoft-stack depth**: Copilot M365 wins.
- **Free Slack-only "for fun"**: Pookie wins.
- **CRM-vertical workflows**: Agentforce wins.
- **Code-editing agent**: Claude Code / Copilot wins.

The lesson: don't try to beat any of them at their own game. Beat
them at being a *workspace teammate*, which none of them is trying
to be — they're all trying to be something else.

## Where we'd win

- **Chat-native + trust posture + action-bias + multi-platform-
  ready.** No one else combines all four. Most combine one or two.
- **Per-channel tone**: novel.
- **Privacy receipts**: novel at this prominence.
- **Self-host with feature parity**: rare; Pookie does it but
  without governance.

## Coexistence is the default, not exclusivity

We design assuming customers have Glean, Notion AI, Atlassian
intelligence, and three internal bots. Sym is the front door, and
those tools sit one MCP call away. Don't try to displace them all;
displace the experience-layer thrash of switching tabs.

## Decisions

- **Do not compete on search depth, code editing, doc editing, or
  CRM verticals.** Integrate with them.
- **Compete on**: chat-substrate UX + trust + action + multi-
  platform + governance.
- **MCP catalog explicitly includes competitors** (Glean, Notion,
  Linear). We win by making the workspace better, not by walling
  things off.

## Open questions

- Do we publish this competitive doc externally in some form (a
  comparison page)? Probably yes, with diplomatic edits.
- Should we have a "vs. pookie" page specifically given how close
  we are? Probably yes — pookie users are highly-qualified leads
  for us.
