# 07 — Permissions & privacy

## The principle

**Sym inherits its access from the platform; it does not re-implement
authorization.** If you can't see #execs in Slack, Sym does not
surface #execs content to you, even if Sym itself was invited there.
If your platform identity isn't an admin, you cannot perform admin
operations on Sym.

This is the single most important rule. Everything else in this doc
is a consequence.

## Why platform-derived auth

Two alternatives, both wrong:

1. **Re-implement permissions.** Sym maintains its own ACL system,
   admins map it to Slack roles. Practical problems: it drifts,
   maintenance burden, two sources of truth, easy to fail open.
2. **Trust the model.** Tell the model "user X is in #payments,
   don't surface #execs content," and rely on it to obey. This is
   what pookie does in spirit. Works most of the time, fails
   sometimes, and "sometimes" is unacceptable.

We take the third path: derive permissions from the platform at
runtime and enforce at the **data layer**, not the prompt.

## How the inheritance works

### Channel access

- Sym, like any user, has an explicit list of channels it's a
  member of (per Slack/Teams API).
- For a given (user, channel) request, Sym checks: is the *user*
  also a member of the channel? If not, Sym does not return content
  from that channel — not in this turn, not via memory recall, not
  via search.
- Cached for short windows (5 min) with platform event invalidation
  on member join/leave.

### Search visibility

- The search builtin only queries channels Sym is in.
- Results are post-filtered: drop any message from a channel the
  *requesting user* isn't in. This is a defense-in-depth check
  because the model could otherwise leak text from search results.

### Memory visibility

Already covered in `03-memory-model.md`, but the rule restated here:
memory recall is scoped to the (user, channel) at request time. The
recall API does not return cross-scope content. Personal-scope
memories belong to the requesting user only.

### Cross-channel implication

- A user in #payments asks "what was discussed in #payments last
  week?" — Sym answers.
- A user *not* in #payments asks the same — Sym says "you don't
  have access to #payments" (or, more honestly, doesn't even
  acknowledge the channel exists if it's private).

### Pookie comparison

Pookie's docs say "Pookie only sees channels it has been invited
to." That's true for *Sym* as well, but it's not enough. Pookie does
not seem to enforce *requester* access — i.e., if I invite pookie to
#payments and you DM pookie, pookie could pull from #payments
context to answer you, even though you're not in #payments.

Sym specifically enforces both:

- The bot must be a member of the source channel (necessary).
- The requesting user must be a member of the source channel
  (additional gate).

Both checks happen at the search/recall layer, not the prompt.

## Admin operations

- Configuring channel policy → channel admin or team admin.
- Approving a skill → team admin.
- Enabling a skill in a channel → channel admin.
- Setting global memory → team admin (or model with admin-attributed
  capture, surfaced for confirmation).
- Setting workspace tone floor → team admin.
- Viewing audit log → team admin.
- Triggering admin-scope deletion (DSAR) → team admin.

All admin actions are platform-side enforced: we check `is_admin`
via the platform API for the originating user. We do not maintain a
separate admin list.

## Identity & impersonation

- A bot acting on a user's behalf (e.g., posting via a skill that
  uses the user's OAuth token) is **logged** with both the human
  user and the bot as actors.
- Skills cannot impersonate other users. A skill executing on
  behalf of Alice can only call APIs with Alice's tokens, not Bob's.
- "Sym posted this" is always visible in the message metadata; we
  never produce messages that appear to be from a human user.

## Secret handling

- OAuth tokens, MCP credentials, customer-managed key material, and
  prompt-embedded secrets are encrypted with a per-team data key
  (envelope encryption).
- Master keys are managed by KMS (AWS KMS / GCP KMS / Vault); never
  in app code.
- Decrypted tokens are kept in memory for the minimum duration
  needed; we don't log secrets, ever.
- The audit log redacts known secret patterns automatically
  (`ghp_…`, `sk_live_…`, `xoxp-…`, etc.).
- Self-hosted operators can plug their own KMS root.

## Privacy receipts

A privacy receipt is a small block attached to each Sym response
that tells the user (and the audit log) what the response was
grounded in. Example, rendered as a tiny footer:

> *Used: 2 channel memories from #payments • Linear (issue PAY-481)
> • thread above (5 msgs) • no personal memory.*

Behavior:

- **Sources used** are listed. Not the contents — just the kinds.
- **No source = obvious hallucination** is detectable. If the model
  produces a claim without retrieval and the claim is non-trivial,
  we flag it.
- **Sensitive sources** are listed as `personal memory (redacted)`
  with no preview. Only the user themselves can see what was
  recalled.
- **Receipts are toggleable**: a user can request the verbose form
  ("show me what you remembered"); admins can require always-on
  receipts for certain channels.

Pookie has nothing equivalent. This is one of Sym's tier-1
differentiators.

## Data residency

- Hosted offering: per-org region selection at install (US, EU,
  AP).
- Data at rest is regional. Cross-region replication only with
  explicit admin consent.
- Logs containing PII are regional too.
- Self-host: customer's problem; we provide the helm chart.

## Retention

- Conversation thread state: 30 days by default, configurable.
- Memory: per `03-memory-model.md` (sensitivity-driven defaults).
- Audit log: 1 year default; admin-configurable up to 7 years.
- Model provider data retention: by default Sym ensures provider-side
  retention is off (Zero Data Retention for hosted offerings); if
  the team's provider doesn't support ZDR, we surface that as a
  policy notice at install.

## GDPR / DSAR

Right-to-access: admin can export all data tied to a user's identity.
Right-to-erasure: admin triggers a deletion sweep across memory,
threads, logs (with appropriate legal-hold exceptions). Right-to-
rectification: standard memory edit flow.

Out of scope: legal-hold workflows beyond what the admin manually
configures. We provide the primitives.

## Tenant isolation (hosted)

- Postgres: row-level security with `org_id` enforced on every
  query.
- Redis: per-tenant key prefix; access via a per-tenant client
  wrapper that injects prefix.
- Workers: stateless; a worker can pick up any task. Tasks
  themselves are encrypted with the org's data key.
- Network: per-tenant rate buckets so a noisy tenant cannot starve
  others.

## Threat model

We protect against:

1. **Cross-channel content leak** via search / recall / memory.
2. **Cross-tenant data leak** (different orgs) via shared
   infrastructure.
3. **Token leakage** in logs / responses.
4. **Skill misuse**: a skill exfiltrating data via its declared but
   over-broad permissions. Mitigated by explicit `requires:` blocks
   and admin approval.
5. **Prompt injection** from external content (web search, MCP
   responses, channel messages from third parties). Mitigated by:
   - Marking external content with a clear `<untrusted_external>`
     envelope in the prompt.
   - Refusing privileged actions sourced solely from untrusted
     content.
   - Audit events on injection-shaped outputs.
6. **Replay** of webhooks / queue messages — mitigated by
   idempotency keys.

We do *not* claim to protect against:

- A user with platform access deliberately exfiltrating data
  through legitimate channels.
- A compromised model provider (this is a contractual / vendor risk,
  not a software risk).
- Determined social-engineering of a human admin into approving a
  malicious skill.

## Compliance posture

Target compliance frames, in priority order:

- SOC 2 Type II (year 1).
- ISO 27001 (year 1 or 2).
- HIPAA-aligned controls available for healthcare-adjacent customers
  (year 2 with BAA).
- GDPR/DPDP/CCPA-aligned data handling from day one.
- FedRAMP — not in scope short-term.

The control set is straightforward; the audit prep is the work.

## Decisions

- **Platform-derived auth**, no parallel ACL.
- **Both bot-access and requester-access** required for every
  retrieval.
- **Envelope encryption** with KMS-managed roots.
- **Privacy receipts on every response**, with admin-configurable
  verbosity.
- **Data residency** at install; regional storage.
- **DSAR** primitives built in from v1.
- **Untrusted-external envelope** required for any externally-
  sourced content reaching the model.

## Open questions

- Customer-managed encryption keys (CMK / BYOK) for hosted —
  necessary for enterprise but adds ops complexity. Likely
  shippable at v2.
- Audit log immutability (write-once storage). v1: append-only with
  per-event hash chain; v2 with WORM storage adapter.
- Cross-channel inference attacks (asking the model to "guess" what
  was in #payments without quoting): mitigated only by training the
  model to refuse, not by retrieval gating. Open problem; we
  document and minimize.
- Federation: cross-organization shared channels (Slack Connect /
  Teams external). Whose policy wins? Probably the channel owner's
  with a clear notice on the foreign side.
