# Sym Database Schema — Draft for Review

## Metadata

- Created: 2026-05-23
- Last Edited: 2026-05-23
- Status: **Draft v0.1 · for schema review session**
- Owner: Sym authors

## Changelog

- 2026-05-23: Initial draft. 19 tables grouped by domain. Conventions
  fixed. Open decisions flagged inline as **DECIDE** and gathered at
  bottom.

---

## Intent

This is the **input** to the Sp2 schema review session, not the
post-review output. It enumerates every table the eight streams need,
proposes columns + types + indexes, and flags every decision the review
must resolve.

**Goals of the review:**
1. Every stream's owner agrees this schema supports their reads + writes.
2. Every cross-unit data flow has a named row/column path.
3. Every `DECIDE` marker has an answer.
4. Naming, types, and conventions are locked before any migration is
   written — schema diff after this point follows the
   `cross-unit-impact` discipline.

**Not goals:**
- Final Drizzle code. One sample file at the bottom shows the pattern;
  the rest is transcribed after approval.
- Indexes beyond the obvious. Performance indexes are added as queries
  emerge; this document covers correctness indexes only.

---

## How to use this document in the review

1. Read **Conventions** — confirm we agree on the rules of the game.
2. Walk **Table inventory** — get the mental map.
3. For each domain group, read the tables in order. For each table, ask:
   - Does it have what my stream needs?
   - Is anything missing that my stream needs to write?
   - Are the keys / FKs correct?
   - Do the enums cover the cases?
4. Resolve every `DECIDE`.
5. Sign off → transcribe to Drizzle in `packages/db/src/schema/`.

---

## Conventions

### Naming

- **Tables:** `snake_case`, plural noun (`workspaces`, `audit_events`).
- **Columns:** `snake_case`.
- **Foreign keys:** `<referenced_table_singular>_id` (`workspace_id`).
- **Booleans:** prefer state nouns over flags (`enabled`, `revoked`)
  unless the meaning is genuinely binary.
- **Timestamps:** `<event>_at` (`created_at`, `revoked_at`, `expires_at`).
- **Enums:** Drizzle `pgEnum` for closed sets; `text` + CHECK only for
  open-ended namespaces (e.g. `audit_events.kind`).

### IDs

- **Primary keys:** UUIDv7 (`text`, time-ordered) generated in app
  via a `uuidv7` helper. Reason: globally unique, sortable, no
  coordination with DB, debug-friendly.
- **Exception — `audit_events.id`:** `bigserial`. Append-heavy, strict
  ordering matters, never exposed outside the audit subsystem.
- **External IDs:** stored as the source of truth's native shape —
  `slack_user_id` (text, e.g. `U0123`), `slack_channel_id` (text),
  `slack_thread_ts` (text — Slack timestamps are strings), `clerk_user_id`
  (text).
- **Branded TypeScript types** for every ID live in `@sym/contracts`.

### Timestamps

- Every table has `created_at timestamptz NOT NULL DEFAULT now()`.
- Mutable tables also have `updated_at timestamptz NOT NULL DEFAULT now()`
  — maintained at the application layer via Drizzle hooks (not Postgres
  triggers — keep DB simple, ORM does it).
- All timestamps `timestamptz`. Never `timestamp`. Never naive datetimes.

### Status fields > soft delete

Sym does not soft-delete. Tables with a lifecycle have an explicit
`status` enum (e.g. `memory_entries.status` = `active | superseded |
forgotten`). Tables that can be revoked have an explicit `revoked_at`
nullable column.

Hard delete is reserved for: ephemeral runtime rows (e.g. expired leases,
consumed checkpoints) via background cleanup jobs.

### Encryption at rest

Secret material uses a Drizzle custom column type `encryptedText` from
`@sym/secrets` (Sp4). Encrypts on write with the workspace key, decrypts
on read. Reads that don't need the plaintext use `encryptedText.cipher`
to avoid decryption cost.

Encrypted columns: `slack_installs.bot_access_token`,
`oauth_tokens.access_token` + `.refresh_token`, `provider_configs.api_key`,
`mcp_configs.env_json` (selectively), `slack_installs.raw_install_payload`.

### Foreign keys

- All FKs declared and indexed.
- `ON DELETE` behavior:
  - **CASCADE** — for per-workspace data that should die with its
    workspace (rare in practice since we never delete workspaces; relevant
    for dev/test resets and worst-case dev migrations).
  - **RESTRICT** — for `audit_events` (history is sacred), `workspaces`
    (don't accidentally delete the root), `slack_installs` (token loss
    is bad).
  - **SET NULL** — for `updated_by_admin_id` (admin departures don't
    invalidate the row they last touched).

### Indexes (in this document)

Only **correctness-required** indexes are listed:
- Unique constraints (uniqueness rules).
- Indexes the query plan must use to avoid sequential scans on large
  tables (audit, memory, messages, tasks).
- FK indexes (Postgres doesn't auto-index FK columns; we declare them).

Performance indexes are added later as `EXPLAIN ANALYZE` warrants.

### Multi-tenancy hygiene

Single-tenant per install, but every row carries `workspace_id` anyway.
Reasons: every query filters by it (defense in depth), backups are
workspace-scoped, RLS becomes possible later without migration. The cost
is negligible.

---

## Table inventory

| # | Table | Domain | Owns |
|---|---|---|---|
| 1 | `workspaces` | Identity | The Sym install itself |
| 2 | `slack_installs` | Identity | Slack workspace bot token + install metadata |
| 3 | `dashboard_admins` | Identity | Clerk-user ↔ Sym-admin role mapping |
| 4 | `acl_modes` | ACL | Per-surface ACL mode (open / allowlist / minus_blocked) |
| 5 | `acl_user_rules` | ACL | Per-user allow/block per surface |
| 6 | `workspace_settings` | Config | Tunables (retention overrides, change-policy thresholds, reporting toggles) |
| 7 | `provider_configs` | Config | LLM provider credentials + model selection per task class |
| 8 | `mcp_configs` | Config | MCP server connection rows |
| 9 | `skills` | Config | Skill content (markdown + frontmatter) |
| 10 | `soul_layers` | Voice | L1/L2/L3 soul rows; L0 is built-in |
| 11 | `memory_entries` | Memory | 5-scope memory with status |
| 12 | `oauth_tokens` | Per-user auth | User-owned third-party provider tokens |
| 13 | `grants` | Per-user auth | Cross-user authorization to use grantor's token |
| 14 | `conversations` | Runtime | A Slack conversation thread (or DM) |
| 15 | `messages` | Runtime | A turn within a conversation |
| 16 | `tasks` | Runtime | Durable queue rows |
| 17 | `checkpoints` | Runtime | Slice resumption blobs |
| 18 | `audit_events` | Audit | Hash-chained append-only log |
| 19 | `leases` | Sandbox | Turn-scoped credential leases for the egress proxy |

---

## 1 — Identity domain

### `workspaces`

Single source of truth for "this Sym install."

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUIDv7 |
| `slack_team_id` | `text` UNIQUE NOT NULL | From Slack `team.id` |
| `name` | `text` NOT NULL | From Slack `team.name` at install; updateable |
| `timezone` | `text` | From Slack `team.timezone` |
| `status` | `enum('active','suspended')` NOT NULL DEFAULT 'active' | |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `updated_at` | `timestamptz` NOT NULL DEFAULT now() | |

**Indexes:** `UNIQUE(slack_team_id)`.

**Notes:**
- Single row in practice for v1 (single-tenant per install). Still
  modelled as a table for clean FKs and future-proofing.
- **DECIDE:** Do we eagerly insert a `workspaces` row on first Slack
  install? (Recommended: yes; install flow writes both `workspaces`
  and `slack_installs` in one transaction.)

### `slack_installs`

The bot install: bot token, scopes, install actor. Separate from
`workspaces` because installs can be re-done (re-auth, scope upgrade)
and we want history.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUIDv7 |
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `bot_user_id` | `text` NOT NULL | Slack `bot_user_id` |
| `app_id` | `text` NOT NULL | Slack `app_id` |
| `bot_access_token` | `encryptedText` NOT NULL | Bot xoxb token |
| `scopes` | `text[]` NOT NULL | Granted scopes at install time |
| `enterprise_id` | `text` | Nullable (Slack Enterprise Grid) |
| `installed_by_slack_user_id` | `text` NOT NULL | User who clicked install |
| `installed_by_admin_id` | `text` FK→dashboard_admins ON DELETE SET NULL | The admin who initiated, if from Dashboard |
| `raw_install_payload` | `encryptedText` | Full OAuth response for forensics |
| `status` | `enum('active','revoked')` NOT NULL DEFAULT 'active' | |
| `revoked_at` | `timestamptz` | |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() | |

**Indexes:** `(workspace_id, status)`; only one `status='active'` row
per workspace (enforced via partial unique: `UNIQUE(workspace_id)
WHERE status = 'active'`).

**Notes:**
- Re-installing creates a new row, marks the old `revoked`.
- The "active" partial unique enforces "one active install per workspace"
  at the DB layer.

### `dashboard_admins`

Mapping from Clerk user → Sym admin role. Lives even if we go with
Clerk Organizations, because we need the join for queries like "who
last edited this config."

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUIDv7 |
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `clerk_user_id` | `text` NOT NULL | From Clerk |
| `email` | `text` NOT NULL | Snapshot at first login; not authoritative |
| `role` | `enum('owner','admin')` NOT NULL DEFAULT 'admin' | |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `created_by_admin_id` | `text` FK→dashboard_admins ON DELETE SET NULL | Null for the bootstrap admin |
| `revoked_at` | `timestamptz` | Soft-removed admin keeps historical FK |

**Indexes:** `UNIQUE(workspace_id, clerk_user_id)`,
`UNIQUE(workspace_id, role) WHERE role = 'owner'` (one owner per
workspace).

**Notes:**
- Bootstrap rule: the user who completes the first Slack OAuth via
  Dashboard becomes `owner`. Additional admins added by existing admins.
- **DECIDE:** Use Clerk Organizations (one org per Sym install) and
  derive admin status from org membership, OR use this table as the
  authoritative source. Recommendation: this table is authoritative;
  Clerk Orgs are optional UI sugar.

---

## 2 — Access control

### `acl_modes`

The per-surface mode setting (one row per `(workspace_id, surface)`).

| Column | Type | Notes |
|---|---|---|
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `surface` | `enum('slack','dashboard')` NOT NULL | |
| `mode` | `enum('open','allowlist','workspace_minus_blocked')` NOT NULL | |
| `updated_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `updated_by_admin_id` | `text` FK→dashboard_admins ON DELETE SET NULL | |
| PRIMARY KEY | `(workspace_id, surface)` | |

**Notes:**
- Default on workspace creation: `slack=open`, `dashboard=allowlist`.
- Policy invariant: dashboard access ⊆ slack access. Enforced at the
  application layer (check before write), not the DB.

### `acl_user_rules`

Per-user allow/block, per surface.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUIDv7 |
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `surface` | `enum('slack','dashboard')` NOT NULL | |
| `slack_user_id` | `text` NOT NULL | |
| `status` | `enum('allow','block')` NOT NULL | |
| `updated_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `updated_by_admin_id` | `text` FK→dashboard_admins ON DELETE SET NULL | |

**Indexes:** `UNIQUE(workspace_id, surface, slack_user_id)`.

**Notes:**
- Interaction with mode:
  - `open` + rule `block` → blocked.
  - `allowlist` + rule `allow` → allowed.
  - `workspace_minus_blocked` + rule `block` → blocked; default allow.

---

## 3 — Configuration

### `workspace_settings`

Per-workspace tunables. Key-value to avoid migration churn on every new
toggle. Use sparingly — settings that warrant first-class columns get
them on `workspaces`.

| Column | Type | Notes |
|---|---|---|
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `key` | `text` NOT NULL | E.g. `memory.retention_days.channel`, `change_policy.repetition_threshold` |
| `value_json` | `jsonb` NOT NULL | |
| `updated_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `updated_by_admin_id` | `text` FK→dashboard_admins ON DELETE SET NULL | |
| PRIMARY KEY | `(workspace_id, key)` | |

**Notes:**
- **DECIDE:** key namespace conventions (dotted vs slash; namespace
  prefixes). Recommended: dotted (`memory.retention_days.channel`).
- Application-layer schema validation per key (Zod schema map).

### `provider_configs`

LLM provider credentials + model selection per task class.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUIDv7 |
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `provider` | `text` NOT NULL | `fireworks` only in v1; future: `openai`, `anthropic`, etc. |
| `api_key` | `encryptedText` NOT NULL | |
| `base_url` | `text` | Nullable; for custom OpenAI-compatible endpoints |
| `model_chat` | `text` NOT NULL | Default chat model |
| `model_tone_rewrite` | `text` NOT NULL | Tone-rewrite stage model (often cheaper) |
| `model_summarization` | `text` NOT NULL | Summary model |
| `extra_models_json` | `jsonb` NOT NULL DEFAULT '{}' | Future task classes |
| `enabled` | `boolean` NOT NULL DEFAULT true | |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `updated_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `updated_by_admin_id` | `text` FK→dashboard_admins ON DELETE SET NULL | |

**Indexes:** `UNIQUE(workspace_id, provider) WHERE enabled = true`
(one active config per provider).

**Notes:**
- Agent reads on every turn; no cache or short cache with invalidation
  on write (cross-unit-impact: writers bump `updated_at`, readers can
  cache for 1s safely).

### `mcp_configs`

MCP server connection rows.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUIDv7 |
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `name` | `text` NOT NULL | Display name |
| `slug` | `text` NOT NULL | Stable identifier within workspace |
| `transport` | `enum('http','stdio')` NOT NULL | |
| `url` | `text` | For `http` transport |
| `command` | `text` | For `stdio` transport |
| `args` | `text[]` NOT NULL DEFAULT '{}' | For `stdio` transport |
| `env_json` | `encryptedText` | JSON map; encrypted because may contain secrets |
| `oauth_config_json` | `jsonb` | Challenge URL, scopes, etc. |
| `enabled` | `boolean` NOT NULL DEFAULT true | |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `updated_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `updated_by_admin_id` | `text` FK→dashboard_admins ON DELETE SET NULL | |

**Indexes:** `UNIQUE(workspace_id, slug)`.

**Notes:**
- CHECK constraint: `(transport = 'http' AND url IS NOT NULL) OR
  (transport = 'stdio' AND command IS NOT NULL)`.

### `skills`

Skill content stored as markdown + frontmatter. Edited via Dashboard.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUIDv7 |
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `slug` | `text` NOT NULL | Stable identifier within workspace |
| `name` | `text` NOT NULL | Display name |
| `description` | `text` NOT NULL | Short description |
| `frontmatter_json` | `jsonb` NOT NULL | Parsed YAML metadata |
| `body_md` | `text` NOT NULL | Markdown body |
| `activation_pattern` | `text` | Lightweight pattern for "should I fire?" |
| `enabled` | `boolean` NOT NULL DEFAULT true | |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `updated_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `updated_by_admin_id` | `text` FK→dashboard_admins ON DELETE SET NULL | |

**Indexes:** `UNIQUE(workspace_id, slug)`.

**Notes:**
- Skills never hold secrets — enforced in the skill loader before write,
  not at the DB layer.

---

## 4 — Voice

### `soul_layers`

L1/L2/L3 soul rows. L0 is hardcoded and never persisted.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUIDv7 |
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `layer` | `enum('l1_workspace','l2_channel','l3_user')` NOT NULL | |
| `scope_id` | `text` | `NULL` for `l1`; `slack_channel_id` for `l2`; `slack_user_id` for `l3` |
| `content_md` | `text` NOT NULL | Markdown body |
| `enabled` | `boolean` NOT NULL DEFAULT true | |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `updated_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `updated_by_admin_id` | `text` FK→dashboard_admins ON DELETE SET NULL | |

**Indexes:**
- `UNIQUE(workspace_id, layer, scope_id)` — at most one row per
  `(layer, scope_id)` per workspace. Postgres treats `NULL`s as distinct
  by default; for `l1_workspace` where `scope_id` is always NULL, we
  enforce one row via a partial unique:
  `UNIQUE(workspace_id, layer) WHERE layer = 'l1_workspace'`.

**Notes:**
- CHECK constraint:
  - `layer = 'l1_workspace' AND scope_id IS NULL`, OR
  - `layer IN ('l2_channel','l3_user') AND scope_id IS NOT NULL`.
- Live-reload via `updated_at` invalidation in the runtime cache.

---

## 5 — Memory

### `memory_entries`

Five-scope memory with change-policy lifecycle.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUIDv7 |
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `scope` | `enum('workspace','channel','thread','dm','custom_relational')` NOT NULL | |
| `scope_key` | `text` | `NULL` for `workspace`; `channel_id` for `channel`; `thread_ts` for `thread`; `slack_user_id` for `dm`; composite `actor:subject` for `custom_relational` |
| `actor_id` | `text` NOT NULL | `slack_user_id` of the user who triggered creation |
| `subject_id` | `text` | `slack_user_id` for `custom_relational`; else `NULL` |
| `content` | `text` NOT NULL | The memory itself |
| `status` | `enum('active','superseded','forgotten')` NOT NULL DEFAULT 'active' | |
| `supersedes_id` | `text` FK→memory_entries ON DELETE SET NULL | The row this one supersedes |
| `subject_consent_status` | `enum('pending','accepted','rejected','not_applicable')` NOT NULL DEFAULT 'not_applicable' | `not_applicable` for non-`custom_relational` scopes |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `updated_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `last_referenced_at` | `timestamptz` | Bumped on retrieval; useful for "interesting" tracking |
| `audit_event_id` | `bigint` FK→audit_events | The write event |

**Indexes (correctness-required):**
- `(workspace_id, scope, scope_key, status)` — primary retrieval path.
- `(workspace_id, subject_id, status) WHERE subject_id IS NOT NULL` —
  custom-relational lookups.
- CHECK constraints:
  - `scope = 'workspace' → scope_key IS NULL`
  - `scope IN ('channel','thread','dm') → scope_key IS NOT NULL AND
    subject_id IS NULL`
  - `scope = 'custom_relational' → subject_id IS NOT NULL AND
    subject_consent_status != 'not_applicable'`

**Notes:**
- The **retrieval gate** runs in `@sym/memory`, not the DB. The schema
  exposes everything; access control is enforced in code.
- The cross-scope red-team CI test (S7a piece 7) writes deliberately
  leaky data and asserts the gate blocks it.
- `subject_consent_status='pending'` rows are written but invisible to
  retrieval until subject accepts.

---

## 6 — Per-user auth

### `oauth_tokens`

User-owned third-party provider tokens (NOT Slack bot, NOT Clerk).

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUIDv7 |
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `slack_user_id` | `text` NOT NULL | Token owner |
| `provider` | `text` NOT NULL | E.g. `github`, `linear`, `calendar`, `sentry` |
| `access_token` | `encryptedText` NOT NULL | |
| `refresh_token` | `encryptedText` | |
| `expires_at` | `timestamptz` | Provider-supplied |
| `scopes` | `text[]` NOT NULL DEFAULT '{}' | |
| `account_handle` | `text` | E.g. GitHub username, for receipts |
| `status` | `enum('active','revoked')` NOT NULL DEFAULT 'active' | |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `updated_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `revoked_at` | `timestamptz` | |

**Indexes:**
- `UNIQUE(workspace_id, slack_user_id, provider) WHERE status = 'active'`
  — one active token per `(user, provider)`.

### `grants`

Cross-user authorization: User A grants User B the right to act through
A's `oauth_tokens` for a provider.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUIDv7 |
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `grantor_slack_user_id` | `text` NOT NULL | A |
| `grantee_slack_user_id` | `text` NOT NULL | B |
| `provider` | `text` NOT NULL | |
| `scopes` | `text[]` NOT NULL | Must be ⊆ grantor's `oauth_tokens.scopes` |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `expires_at` | `timestamptz` NOT NULL | ≤ 7d from `created_at` |
| `revoked_at` | `timestamptz` | |
| `revoked_by_slack_user_id` | `text` | |

**Indexes:**
- `(workspace_id, grantee_slack_user_id, provider, expires_at) WHERE
  revoked_at IS NULL` — grant lookup at tool-call time.

**Notes:**
- Non-transitive: grantee cannot re-grant. Enforced in code.
- Scope subset check enforced in code at grant creation.
- Default TTL 24h; max 7d.

---

## 7 — Runtime conversation

### `conversations`

A Slack conversation thread (or DM) Sym is participating in.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUIDv7 |
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `entry_surface` | `enum('app_mention','dm','shortcut','slash_command','task')` NOT NULL | |
| `slack_channel_id` | `text` | Null for DMs from `im` channels (we still store the `im` channel id here actually) |
| `slack_thread_ts` | `text` | Null for top-level / DM |
| `initiator_slack_user_id` | `text` NOT NULL | |
| `status` | `enum('active','closed')` NOT NULL DEFAULT 'active' | |
| `started_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `last_turn_at` | `timestamptz` NOT NULL DEFAULT now() | |

**Indexes:** `(workspace_id, slack_channel_id, slack_thread_ts)`.

**Notes:**
- **DECIDE:** Do we treat DMs as their own conversation per Slack `im`
  channel (one conversation forever) or per "session" (auto-close after
  N hours of inactivity)? Recommend: per `im` channel, never auto-close.

### `messages`

A turn within a conversation. One row per inbound user message, one row
per outbound assistant reply, one row per tool call/result we want to
persist (kept terse; full tool I/O is in audit).

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUIDv7 |
| `workspace_id` | `text` NOT NULL FK→workspaces | Denormalized for workspace-scoped scans |
| `conversation_id` | `text` NOT NULL FK→conversations | |
| `role` | `enum('user','assistant','system','tool')` NOT NULL | |
| `author_slack_user_id` | `text` | Null for assistant/system |
| `content_json` | `jsonb` NOT NULL | Block Kit JSON / text / tool calls / tool results |
| `slack_ts` | `text` | Slack `ts` when posted; null for synthetic system messages |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `audit_event_id` | `bigint` FK→audit_events | |

**Indexes:** `(conversation_id, created_at)`.

---

## 8 — Runtime queue

### `tasks`

Durable queue rows. Pop pattern: `SELECT ... FOR UPDATE SKIP LOCKED`.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUIDv7 |
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `kind` | `text` NOT NULL | E.g. `turn`, `digest`, `pr_watcher` |
| `payload_json` | `jsonb` NOT NULL | |
| `status` | `enum('pending','running','completed','failed','dead_letter')` NOT NULL DEFAULT 'pending' | |
| `due_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `locked_until` | `timestamptz` | Set by worker on dequeue |
| `attempts` | `integer` NOT NULL DEFAULT 0 | |
| `max_attempts` | `integer` NOT NULL DEFAULT 5 | |
| `last_error` | `text` | |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `started_at` | `timestamptz` | |
| `completed_at` | `timestamptz` | |

**Indexes:** `(status, due_at) WHERE status = 'pending'` — the hot path.

### `checkpoints`

Slice resumption blobs. One per `(conversation_id, slice_id)`.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUIDv7 |
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `conversation_id` | `text` NOT NULL FK→conversations | |
| `slice_id` | `text` NOT NULL | Unique within conversation |
| `version` | `integer` NOT NULL | Kernel state schema version |
| `state_blob` | `bytea` NOT NULL | Serialized kernel state |
| `created_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `consumed_at` | `timestamptz` | Set when slice resumed |
| `expires_at` | `timestamptz` NOT NULL | TTL — cleanup job purges |

**Indexes:** `UNIQUE(conversation_id, slice_id)`,
`(expires_at) WHERE consumed_at IS NULL`.

---

## 9 — Audit

### `audit_events`

Append-only, hash-chained.

| Column | Type | Notes |
|---|---|---|
| `id` | `bigserial` PK | Strictly ordered |
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `kind` | `text` NOT NULL | Namespaced: `app.memory.write`, `gen_ai.completion`, `messaging.slack.send`, `app.lease.issue`, etc. |
| `actor_kind` | `enum('slack_user','admin','system','sandbox')` NOT NULL | |
| `actor_id` | `text` NOT NULL | `slack_user_id` / `clerk_user_id` / `sandbox_jwt_id` / `'system'` |
| `on_behalf_of` | `text` | For cross-user grants |
| `target_kind` | `text` | E.g. `memory`, `tool`, `lease` |
| `target_id` | `text` | |
| `payload_json` | `jsonb` NOT NULL | Event-specific body |
| `prev_hash` | `bytea` | NULL for the first event in a workspace's chain |
| `this_hash` | `bytea` NOT NULL | sha256(prev_hash ‖ canonical_json(other_columns)) |
| `ts` | `timestamptz` NOT NULL DEFAULT now() | |

**Indexes:** `(workspace_id, ts)`, `(workspace_id, kind, ts)`.

**Notes:**
- Append serialized per workspace at the application layer (one writer
  per workspace at a time, via Redis advisory lock or PG advisory lock)
  to keep the chain linear.
- Hash chain verification is a CI test + a periodic background job.
- `kind` is open namespace; conventions documented in
  `specs/logging/semantics.md`.
- **DECIDE:** advisory lock implementation — Postgres
  `pg_advisory_xact_lock` keyed on hash of `workspace_id` (no extra infra)
  vs Redis lock. Recommend Postgres advisory lock for simplicity.

---

## 10 — Sandbox

### `leases`

Turn-scoped credential leases for the egress proxy. One per
`(turn, provider, domain)` issued just before sandbox spawn, consumed
by the proxy during the turn, purged after expiry.

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | UUIDv7 |
| `workspace_id` | `text` NOT NULL FK→workspaces | |
| `turn_id` | `text` NOT NULL | Loose link to the turn (kernel-generated) |
| `sandbox_jwt_id` | `text` NOT NULL UNIQUE | `jti` of the sandbox JWT |
| `requester_slack_user_id` | `text` NOT NULL | Who initiated |
| `provider` | `text` NOT NULL | |
| `domain` | `text` NOT NULL | Egress destination, e.g. `api.github.com` |
| `oauth_token_id` | `text` NOT NULL FK→oauth_tokens | Which token to inject |
| `on_behalf_of_slack_user_id` | `text` | For grants |
| `grant_id` | `text` FK→grants | Set when used via a grant |
| `issued_at` | `timestamptz` NOT NULL DEFAULT now() | |
| `expires_at` | `timestamptz` NOT NULL | ≤ turn duration |
| `consumed_at` | `timestamptz` | Last use timestamp |
| `use_count` | `integer` NOT NULL DEFAULT 0 | |

**Indexes:**
- `UNIQUE(sandbox_jwt_id)`.
- `(expires_at)` — cleanup scan.
- `(workspace_id, requester_slack_user_id, provider, domain)
  WHERE consumed_at IS NULL` — proxy lookup.

**Notes:**
- The lease store is also kept hot in memory in the egress proxy; Postgres
  is the encrypted backup.
- Background job purges rows older than `expires_at + 1 day`.

---

## Cross-table relationships (text ER)

```
workspaces ◀────────── slack_installs
    ▲    ▲
    │    └────────────── dashboard_admins (FK self for created_by)
    │
    ├── acl_modes        (PK: workspace_id + surface)
    ├── acl_user_rules
    ├── workspace_settings
    ├── provider_configs
    ├── mcp_configs
    ├── skills
    ├── soul_layers
    ├── memory_entries ───────────────► audit_events (audit_event_id)
    │       │
    │       └─ supersedes_id ──► memory_entries (FK self)
    │
    ├── oauth_tokens ◀─────── leases (FK)
    ├── grants ◀───────────── leases (FK)
    │
    ├── conversations ◀───── messages
    │       ▲                   │
    │       └───── checkpoints   │
    │                            │
    │                            └──► audit_events (audit_event_id)
    │
    ├── tasks
    └── audit_events (bigserial, hash chain, no FK back to most things)

leases ───► oauth_tokens (which token to inject)
leases ───► grants       (if acting on behalf of)
```

Notes on the diagram:
- Everything roots at `workspaces`.
- `audit_events` is the only table other tables reference by id (write
  trail), but `audit_events` itself only references `workspaces`.
- `memory_entries.supersedes_id` is a self-FK for the change history
  chain.

---

## Sample Drizzle file (one example for the pattern)

`packages/db/src/schema/workspaces.ts`:

```ts
import { pgTable, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { uuidv7 } from '../uuid';

export const workspaceStatusEnum = pgEnum('workspace_status', [
  'active',
  'suspended',
]);

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey().$defaultFn(uuidv7),
  slackTeamId: text('slack_team_id').notNull().unique(),
  name: text('name').notNull(),
  timezone: text('timezone'),
  status: workspaceStatusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Pattern rules:
- One enum per `pgEnum` declaration, top of file.
- One `pgTable` per file (or per closely-related group).
- Branded TypeScript types from `@sym/contracts` applied via
  `.$type<WorkspaceId>()` on id columns where it adds value.
- Encrypted columns: `encryptedText('bot_access_token')` (custom type
  from `@sym/secrets`).
- Indexes declared via Drizzle's `index()` / `uniqueIndex()` helpers
  outside the column definitions, in a second arg to `pgTable`.

---

## Open decisions for the review

| ID | Decision | Recommendation |
|---|---|---|
| **D-DB-1** | Eagerly insert `workspaces` row on first Slack install? | **Yes** — install flow writes `workspaces` + `slack_installs` in one transaction |
| **D-DB-2** | Clerk Organizations vs `dashboard_admins` table as authoritative source? | **`dashboard_admins` authoritative**; Clerk Orgs optional UI sugar later |
| **D-DB-3** | `workspace_settings` key namespace convention | **Dotted** (`memory.retention_days.channel`); Zod schema map enforces values |
| **D-DB-4** | DM conversation lifecycle: forever-per-im-channel vs auto-close after inactivity | **Forever-per-im-channel** — Slack threads are the natural conversation boundary, DMs aren't really "sessions" |
| **D-DB-5** | Audit hash chain serialization mechanism | **Postgres advisory lock** (`pg_advisory_xact_lock(hashtext(workspace_id))`) — no extra infra |
| **D-DB-6** | Where to put kernel state schema version for `checkpoints.version` | Constant in `@sym/kernel`; bumped on any kernel state shape change; **DECIDE** the version-1 number — recommend `1` (avoid clever encoding) |
| **D-DB-7** | Hard delete cadence for expired leases + consumed checkpoints | **Daily background job**; tunable via `workspace_settings` |
| **D-DB-8** | Should `messages` store full Block Kit JSON for outbound replies, or just text + a reference to the audit_event? | **Full Block Kit JSON** — costs storage but enables Dashboard "show conversation as Sym sees it" without joining audit |
| **D-DB-9** | `audit_events.payload_json` size limits | **DECIDE**: cap at 64KB per event; oversize payloads write a pointer to object storage (later); for v1, just cap with CHECK constraint |
| **D-DB-10** | Tasks: separate queue per `kind`, or one queue table with `kind` discriminant? | **One table** with `kind` column + index — operationally simpler; perf concern only materializes at scale we don't have yet |
| **D-DB-11** | Drizzle migration tooling — `drizzle-kit generate` (auto-diff) or hand-written migrations? | **Hand-written** for non-trivial changes (renames, backfills); `drizzle-kit generate` for additive starting points; review every output before applying |
| **D-DB-12** | Backup / PITR strategy for Postgres | Out of scope for this review; tracked separately under S8 |

---

## Out of scope (deliberately)

- **Vector storage** for memory recall. v1.x adds `pgvector` on
  `memory_entries.content_embedding`. Not modelled here.
- **Multi-workspace tenancy.** Single tenant per install; `workspace_id`
  is present everywhere for future-proofing but no current code uses it
  for tenant isolation across rows.
- **Per-channel/per-user retention overrides.** Modelled via
  `workspace_settings` keys, not first-class columns.
- **OTel exporter target configuration.** Lives in env / Dokploy
  secrets, not the DB.
- **Reporting metrics tables.** Lightweight reporting in v1 queries
  `audit_events` directly; pre-aggregated tables come later.
- **Long-form artifact storage** (Canvas content, file uploads). Stored
  in Slack-native surfaces; we reference by id in messages/audit but
  don't store the bytes.

---

## Related

- `docs/implementation-ideology-plan.md` — the build flow that calls
  this schema Sp2.
- `docs/specs/sym-overview-spec.md` — product thesis, the storage table
  that informed this draft.
- `.claude/skills/cross-unit-impact/SKILL.md` — discipline that governs
  every change to this schema after lock.
- `docs/specs/security-policy.md` — referenced for secrets-at-rest
  posture (libsodium application-layer encryption).
