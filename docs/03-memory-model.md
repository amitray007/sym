# 03 — Memory model

## Why memory deserves its own doc

Memory is where the trust thesis lives or dies. If a memory remembered
in #payments leaks into #general, the entire promise of "AI teammate
that respects confidentiality" collapses. If it never does, we have
something genuinely defensible.

This doc covers:

1. The four scopes and their semantics.
2. How memories are written (capture).
3. How memories are retrieved (recall).
4. Cross-scope leak prevention.
5. Retention, deletion, and the privacy contract.

## Scopes

Sym has **four** memory scopes, one more than pookie's three. The
extra one is *project*, which we'll explain below.

| Scope | Key | Visible to | Typical contents |
|---|---|---|---|
| `personal` | `(org, user)` | only that user | preferences, role, style, working hours, my-projects |
| `channel` | `(org, channel)` | members of that channel | repo, owners, channel norms, in-channel decisions |
| `project` | `(org, project)` | members of all linked channels | cross-channel project state, OKRs, milestones |
| `team` | `(org)` | everyone in the org | company facts, holiday calendar, glossary |

### Why a `project` scope distinct from `channel`?

A common pattern: one project spans multiple Slack channels
(#proj-fooBackend, #proj-fooFrontend, #proj-foo-design). Channel-scoped
memory means each of those re-learns the same project facts. A team-
scoped memory leaks project context to people in the org who aren't
on the project.

Project is the missing middle. Channels are *linked* to projects via
admin config; project memories are visible in any linked channel and
in DMs with project members.

Pookie does not have this because pookie is workspace-level enough to
not need it. At work scale, projects span channels routinely. We need
the layer.

### What about `thread` scope?

A thread is a conversation, not a memory scope. The thread's
conversation state is held by the runtime, not the memory service.
"Memory" implies *durable beyond the conversation* — so thread state
is its own thing (see `02-architecture.md`).

## Memory entries

Every entry has the shape:

```ts
interface MemoryEntry {
  id: string;                       // ulid
  scope: "personal" | "channel" | "project" | "team";
  ownerKey: string;                 // org+user / org+channel / org+project / org
  content: string;                  // the note itself
  author: { orgId: string; userId: string };
  createdAt: number;
  lastSeenAt: number;               // refreshed on recall
  source: {
    threadId?: string;
    messageId?: string;
    skill?: string;                 // if captured by a skill, e.g. "summarize-decision"
  };
  retention: {
    ttlDays?: number;               // null = forever (until offboard/delete)
    sensitivity: "low" | "moderate" | "sensitive";
  };
  metadata: {
    why?: string;                   // "user corrected me about preferred timezone"
    tags?: string[];
  };
  contentHash: string;              // for audit
}
```

### Why include `why`?

Pookie's memory tool explicitly asks the model to include "why this
matters" with each note ("prefers TypeScript over Python — corrected
me" beats "uses TypeScript"). We're keeping this; it dramatically
improves the model's ability to apply the rule correctly later.

### Why a `sensitivity` tier?

Sensitivity drives retention default, redaction in receipts, and
admin-visible audit verbosity. "low" can appear in privacy receipts
verbatim; "sensitive" appears as "1 personal memory recalled
[redacted]". This is closer to how a discreet teammate behaves.

## Capture (writing memory)

### When the agent writes

The agent writes memory when:

- A user corrects it ("not X, Y") — high signal, almost always
  capture.
- A user states a durable preference, fact, or role assignment.
- A user defines a channel/project convention.
- A user explicitly says "remember that …".
- A long-running task captures intermediate state worth surfacing
  later.

Pookie's system prompt phrases this well; we're adopting their
heuristic. The key is *liberal capture, conservative scope*.

### Scope choice

The agent must choose a scope. The rules:

- Default to **personal** if the note is about the speaker.
- Default to **channel** if the note is about the channel
  (repo, ownership, norm).
- Choose **project** only if the channel is linked to a project and
  the fact applies to the project not the channel.
- Choose **team** only with admin approval or for clearly team-wide
  facts (e.g., "we're on the Stripe Enterprise plan").

Scope choice is part of the memory write API and is auditable.

### Capture confirmation

The agent inlines a tiny capture indicator in its response:

```
remembered (personal): you prefer Tuesday standups over Mondays
```

The user can react with a removal emoji or say "forget that" to undo
within a short window without admin involvement. After the window
expires, deletion requires the `forget` tool or admin action.

### De-duplication

Before writing, the service checks the last N entries in the same
scope for a normalized-string duplicate. Duplicates short-circuit to
"already remembered" without growing the store. Pookie does this; we
keep it.

### Conflict resolution

If the new note contradicts an existing one, the agent surfaces the
conflict:

> I had this remembered: "Alice owns the payments service." You're
> telling me Bob owns it now. Want me to update?

The user confirms; the old entry is superseded but not deleted (kept
with a `supersededBy` pointer, for audit).

## Recall (reading memory)

### The retrieval contract

When the runtime needs memory for a turn, it calls:

```ts
const memories = await memoryService.recall({
  orgId,
  userId,         // for personal scope
  channelId,      // for channel scope
  projectId,      // for project scope (resolved from channel via admin config)
  query?,         // optional — vector search if provided
  budget: { maxChars: 8000, maxEntries: 40 },
});
```

The service returns only entries the caller is *entitled* to see for
this (user, channel) tuple. Specifically:

- Personal-for-this-user (`user == requester`).
- Channel-for-this-channel (`channel == current channel`).
- Project-for-the-project-this-channel-belongs-to (if any).
- Team-for-the-org.

**The service never returns memories from a different user's personal
scope, a different channel, or a different project.** Even if the
model "asks for them," the API doesn't surface them. Cross-scope
recall is enforced at the call site, not in the prompt.

### Vector vs. keyword

Pookie uses recency + char budget. That works for small stores. We'll
combine:

- A small **recency / most-frequently-recalled** window (always
  loaded, like pookie's approach).
- A **vector recall** over the rest of the scope's entries, gated by
  query relevance.

Why both: a teammate should always remember "you prefer Tuesday
standups" without being prompted, and should also surface "you said
the database is on us-east-2" only when a question makes it relevant.

### Eviction & size limits

Each scope has a hard cap (e.g., 1,000 entries per channel). When the
cap is hit, entries are evicted by a score:

```
score = recency_weight * lastSeenAt + frequency_weight * accessCount
        - sensitivity_penalty
```

Sensitive entries are eviction-resistant (cost of forgetting too
much is high). Low-sensitivity, never-recalled entries are evicted
first.

## Cross-scope leak prevention

The architectural commitment: the model **cannot retrieve** what it
isn't entitled to, and the prompt **does not contain** strings from
inaccessible scopes.

Concretely:

1. The recall API never returns mixed-scope results.
2. The runtime never concatenates "all memories for this user" — it
   asks per-scope and tags each entry with its origin in the prompt.
3. Privacy receipts attached to responses tell users exactly what
   scopes were read.
4. A red-team test suite (`tests/scope-leak/`) feeds adversarial
   queries that try to extract cross-scope info; CI fails if any
   leak.

### Threat model

What we're protecting against:

- A user in #general asking "what did Alice say in #payments?" and
  the model surfacing it from channel memory.
- A user asking "what do you remember about Bob?" and getting Bob's
  personal-scope notes.
- A model that hallucinates and "remembers" something it shouldn't —
  caught by the receipt (no source = obvious hallucination).
- A skill that reads memory and posts it elsewhere — caught by audit
  events.

What we're *not* protecting against:

- A user with legitimate access to two channels copying content
  between them. That's a human policy problem.
- A user whose org identity is compromised. Out of scope at this
  layer.

## Retention & deletion

### Default retention

- `low` sensitivity: kept until evicted or explicitly forgotten.
- `moderate`: kept 1 year, then auto-archived (still recallable on
  explicit request).
- `sensitive`: kept 90 days unless renewed by a recall in that
  window.

Admins can override per-scope.

### Deletion

Five deletion paths:

1. **User-initiated forget** within the response confirmation window
   (~5 minutes).
2. **`forget` tool** call by the user any time (matches by string;
   pookie's pattern, kept).
3. **Channel archive**: when a Slack channel is archived, its
   channel memories are soft-deleted (recoverable for 30 days, hard-
   deleted after).
4. **Project sunset**: an admin action.
5. **User offboarding (SCIM deprovision)**: personal memories
   tombstoned immediately; team-scoped memories *authored* by the
   user are kept with author replaced by `<former employee>`.

### GDPR / DSAR

A right-to-be-forgotten request triggers tombstoning of all entries
authored by the subject, plus a sweep of any team/channel/project
entries that *mention* the subject by name (NER pass with a redaction
operation). The audit log of the deletion is itself retained per
policy.

## Decisions

- **Four scopes**: personal, channel, project, team. Project is new
  vs. pookie.
- **Retrieval enforced at the service**, not the model.
- **Every entry has `why`, `sensitivity`, `source` metadata.**
- **Capture indicators surfaced to the user** with a quick-undo
  window.
- **Hybrid recency + vector recall.**
- **Hard caps per scope with score-based eviction.**
- **CI red-team tests required for leak prevention.**
- **DSAR-compliant deletion pipeline from day one** (not "later").

## Open questions

- How do we resolve channel→project links? Admin config in v1;
  auto-suggest from channel naming patterns in v2.
- Cross-scope inference attacks (the model deduces something from
  what it *is* allowed to see) — what's our policy? Probably
  documented limitation, not solved at this layer.
- Should sensitive entries require a passphrase / second factor to
  be recalled? Probably not for v1; revisit if regulated industries
  ask.
- Memory for *the agent itself* — operational notes, "this skill
  tends to be slow" — distinct from team memory? Likely yes, scope
  `system`, not user-readable but admin-readable.
