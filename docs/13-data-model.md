# 13 — Data model

## What this doc covers

Concrete schemas and key namespaces for the persistent state Sym
keeps. Engineering-flavored. If you're designing tables, you live
here.

We use Postgres (with `pgvector` extension for v1.x recall) for
durable state and Redis for hot caches + the queue (Postgres-backed
queue, see `05-tasks-async.md`).

All tables include `org_id` and are protected by Postgres row-level
security. The application connects with a per-request role that
asserts the org context.

## Conventions

- Primary keys: `ulid()` for everything except natural keys.
- All timestamps: `timestamptz` storing UTC.
- All "soft delete" patterns: `deleted_at` nullable column +
  partial indexes.
- All encrypted fields: stored as `bytea` containing the AEAD
  ciphertext, with key reference in a sibling column.

## Core tables

### organizations

```sql
CREATE TABLE organizations (
  org_id          TEXT PRIMARY KEY,           -- "org_01H8XYZ"
  display_name    TEXT NOT NULL,
  plan            TEXT NOT NULL DEFAULT 'pilot',
  region          TEXT NOT NULL DEFAULT 'us', -- us | eu | ap
  data_key_ref    TEXT NOT NULL,              -- KMS reference for org data key
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
```

### org_users

```sql
CREATE TABLE org_users (
  org_user_id     TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(org_id),
  email           CITEXT NOT NULL,
  display_name    TEXT,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | deprovisioned
  created_at      timestamptz NOT NULL DEFAULT now(),
  deprovisioned_at timestamptz,
  UNIQUE (org_id, email)
);
```

### platform_identities

```sql
CREATE TABLE platform_identities (
  id                TEXT PRIMARY KEY,
  org_user_id       TEXT NOT NULL REFERENCES org_users(org_user_id),
  platform          TEXT NOT NULL,    -- slack | teams | discord
  platform_user_id  TEXT NOT NULL,
  platform_team_id  TEXT NOT NULL,
  raw_profile       JSONB,
  linked_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, platform_team_id, platform_user_id)
);
```

The composite unique key + the `org_user_id` join lets us look up
"who is this Slack user?" in O(1).

### platform_installs

```sql
CREATE TABLE platform_installs (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES organizations(org_id),
  platform            TEXT NOT NULL,
  platform_team_id    TEXT NOT NULL,
  bot_user_id         TEXT NOT NULL,
  oauth_token_enc     BYTEA NOT NULL,           -- envelope-encrypted
  oauth_scopes        TEXT[] NOT NULL,
  installed_by        TEXT REFERENCES org_users(org_user_id),
  installed_at        timestamptz NOT NULL DEFAULT now(),
  uninstalled_at      timestamptz,
  UNIQUE (platform, platform_team_id)
);
```

### channels

```sql
CREATE TABLE channels (
  channel_id        TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(org_id),
  platform          TEXT NOT NULL,
  platform_channel_id TEXT NOT NULL,
  display_name      TEXT,
  is_private        BOOL NOT NULL DEFAULT false,
  is_dm             BOOL NOT NULL DEFAULT false,
  project_id        TEXT REFERENCES projects(project_id),
  archived_at       timestamptz,
  UNIQUE (platform, platform_channel_id)
);
```

### projects

```sql
CREATE TABLE projects (
  project_id      TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(org_id),
  display_name    TEXT NOT NULL,
  description     TEXT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);
```

### channel_policies

```sql
CREATE TABLE channel_policies (
  channel_id        TEXT PRIMARY KEY REFERENCES channels(channel_id),
  tone_formality    TEXT NOT NULL DEFAULT 'neutral',
  tone_warmth       TEXT NOT NULL DEFAULT 'neutral',
  audience_tags     TEXT[] NOT NULL DEFAULT '{}',
  receipts_mode     TEXT NOT NULL DEFAULT 'compact', -- compact | expanded | off
  proactive_speech  TEXT NOT NULL DEFAULT 'off',    -- off | opt_in | enabled
  enabled_skills    TEXT[] NOT NULL DEFAULT '{}',   -- subset of org-approved skills
  updated_at        timestamptz NOT NULL DEFAULT now()
);
```

### org_policies

```sql
CREATE TABLE org_policies (
  org_id              TEXT PRIMARY KEY REFERENCES organizations(org_id),
  tone_floor          TEXT NOT NULL DEFAULT 'neutral',
  default_model       TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  fallback_model      TEXT,
  budget_monthly_usd  NUMERIC(12,2),
  retention_days_audit INT NOT NULL DEFAULT 365,
  retention_days_threads INT NOT NULL DEFAULT 30,
  egress_allowlist    TEXT[] NOT NULL DEFAULT '{}',
  data_residency_region TEXT NOT NULL DEFAULT 'us',
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

## Memory

### memories

```sql
CREATE TABLE memories (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES organizations(org_id),
  scope           TEXT NOT NULL,  -- personal | channel | project | team
  owner_key       TEXT NOT NULL,  -- e.g. "user:org_user_id" | "channel:channel_id" | "project:project_id" | "team"
  content_enc     BYTEA NOT NULL,
  content_hash    TEXT NOT NULL,
  author_user_id  TEXT REFERENCES org_users(org_user_id),
  source          JSONB NOT NULL DEFAULT '{}',  -- { thread_id, message_id, skill }
  sensitivity     TEXT NOT NULL DEFAULT 'low',
  why             TEXT,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  ttl_days        INT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  access_count    INT NOT NULL DEFAULT 0,
  superseded_by   TEXT REFERENCES memories(id),
  tombstoned_at   timestamptz
);

CREATE INDEX memories_scope_owner_seen ON memories(org_id, scope, owner_key, last_seen_at DESC)
  WHERE tombstoned_at IS NULL;
```

For v1.x with vector recall, add:

```sql
ALTER TABLE memories ADD COLUMN embedding vector(1536);
CREATE INDEX memories_embedding ON memories USING ivfflat (embedding vector_cosine_ops);
```

The encryption strategy: `content_enc` is the AEAD ciphertext using
the org's data key (resolved from `organizations.data_key_ref`). The
`content_hash` is a SHA-256 of the plaintext, used for dedup and
audit references.

### memory_audit

Reads and writes also emit events into the audit log (see below),
but `memories.access_count` is a fast counter for eviction scoring.

## Threads / conversation state

### threads

```sql
CREATE TABLE threads (
  thread_id         TEXT PRIMARY KEY,    -- platform-derived (e.g. slack thread_ts)
  org_id            TEXT NOT NULL,
  platform          TEXT NOT NULL,
  channel_id        TEXT NOT NULL REFERENCES channels(channel_id),
  conversation_enc  BYTEA NOT NULL,      -- encrypted ModelMessage[]
  last_active_at    timestamptz NOT NULL DEFAULT now(),
  message_count     INT NOT NULL DEFAULT 0,
  locked_until      timestamptz          -- for thread lock
);
```

The `conversation_enc` is a single blob, encrypted, holding the
full message history for the thread. Same approach as pookie.

### thread_followups

```sql
CREATE TABLE thread_followups (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES threads(thread_id),
  message_id  TEXT NOT NULL,
  text        TEXT NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  drained_at  timestamptz
);
```

In-Postgres queue for messages arriving while the thread is locked.
Drained on the next agent run.

## Skills & MCP

### skill_catalog

```sql
CREATE TABLE skill_catalog (
  skill_name     TEXT PRIMARY KEY,
  latest_version TEXT NOT NULL,
  manifest       JSONB NOT NULL,   -- the manifest YAML normalized to JSON
  publisher      TEXT NOT NULL,
  published_at   timestamptz NOT NULL DEFAULT now()
);
```

Global; shared across orgs (it's our curated catalog).

### org_skill_approvals

```sql
CREATE TABLE org_skill_approvals (
  org_id        TEXT NOT NULL,
  skill_name    TEXT NOT NULL,
  status        TEXT NOT NULL,     -- proposed | approved | rejected | suspended
  pinned_version TEXT,
  approved_by   TEXT REFERENCES org_users(org_user_id),
  approved_at   timestamptz,
  notes         TEXT,
  PRIMARY KEY (org_id, skill_name)
);
```

### mcp_connections

```sql
CREATE TABLE mcp_connections (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  scope           TEXT NOT NULL,         -- user | channel | team
  scope_key       TEXT NOT NULL,         -- e.g. "user:org_user_id"
  preset          TEXT,                  -- linear | github | ... (null for custom)
  display_alias   TEXT,                  -- "linear_personal", "linear_work"
  server_url      TEXT NOT NULL,
  auth_method     TEXT NOT NULL,         -- oauth | token | none
  auth_enc        BYTEA,                 -- encrypted token bundle
  created_by      TEXT REFERENCES org_users(org_user_id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  status          TEXT NOT NULL DEFAULT 'active',
  last_health_at  timestamptz,
  health_status   TEXT
);

CREATE UNIQUE INDEX mcp_connections_scope_alias
  ON mcp_connections(org_id, scope, scope_key, COALESCE(display_alias, ''));
```

## Tasks

### tasks

```sql
CREATE TABLE tasks (
  task_id         TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  created_by      TEXT REFERENCES org_users(org_user_id),
  channel_id      TEXT REFERENCES channels(channel_id),
  thread_id       TEXT,
  spec            JSONB NOT NULL,        -- typed TaskSpec
  status          TEXT NOT NULL,
  state           JSONB NOT NULL DEFAULT '{}',
  triggers        JSONB NOT NULL DEFAULT '[]',
  cron_expression TEXT,
  next_run_at     timestamptz,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  result          JSONB,
  cancelled_at    timestamptz,
  cancelled_by    TEXT REFERENCES org_users(org_user_id),
  failure_count   INT NOT NULL DEFAULT 0
);

CREATE INDEX tasks_next_run ON tasks(next_run_at) WHERE status IN ('scheduled','waiting');
```

### task_history

```sql
CREATE TABLE task_history (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(task_id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  kind        TEXT NOT NULL,            -- fire | step | success | failure | cancel
  payload     JSONB NOT NULL DEFAULT '{}'
);
```

### task_queue

```sql
CREATE TABLE task_queue (
  id               BIGSERIAL PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(task_id),
  occurrence_key   TEXT NOT NULL,                       -- idempotency
  visible_at       timestamptz NOT NULL DEFAULT now(),
  claimed_at       timestamptz,
  claim_token      TEXT,
  finished_at      timestamptz,
  UNIQUE (task_id, occurrence_key)
);

CREATE INDEX task_queue_visible ON task_queue(visible_at)
  WHERE claimed_at IS NULL AND finished_at IS NULL;
```

A Postgres-backed durable queue. Workers `SELECT ... FOR UPDATE
SKIP LOCKED` to claim. Pookie does similar work via Vercel Queues;
we get parity in self-host by keeping the queue inside Postgres.

## Audit

### events

```sql
CREATE TABLE events (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  trace_id        TEXT,
  span_id         TEXT,
  parent_span_id  TEXT,
  ts              timestamptz NOT NULL,
  actor           JSONB NOT NULL,
  action          TEXT NOT NULL,
  resource        JSONB,
  result          TEXT NOT NULL,
  attributes      JSONB NOT NULL DEFAULT '{}',
  redacted_fields TEXT[] NOT NULL DEFAULT '{}',
  prev_hash       TEXT,
  hash            TEXT NOT NULL
);

CREATE INDEX events_org_ts ON events(org_id, ts DESC);
CREATE INDEX events_action ON events(org_id, action, ts DESC);
```

The `prev_hash`/`hash` columns form an append-only hash chain
(per-org). Tampering with the chain is detectable.

## Redis namespaces

Hot caches and ephemeral coordination:

- `lock:thread:{org}:{thread_id}` — thread lock with TTL.
- `cache:channel_members:{org}:{channel_id}` — short-TTL channel
  membership.
- `cache:tool_results:{org}:{trace_id}:{tool_call_id}` — within-run
  tool result memoization.
- `rate:org:{org}:{bucket}` — token bucket counters.
- `flag:tone_disabled:{org}` — feature flags per org.

Keys are prefixed by tenant; the client wrapper enforces this.

## Encryption keys

- Per-tenant data key (DEK), AEAD (XChaCha20-Poly1305 or AES-256-
  GCM).
- DEK wrapped by an org-level KEK in KMS.
- KEK rotation is supported (rewrap DEKs, no data re-encryption).
- DEK rotation is offline-only (re-encrypt content), used on
  incident response.

All sensitive `*_enc` columns reference the DEK; the DEK reference
lives on `organizations.data_key_ref`.

## Migrations & versioning

- Schema version table; migrations are forward-only (no down
  migrations in production).
- Backfills for index changes use chunked background jobs.
- Multi-version compatibility: new code reads N-1 schema; old code
  reads N schema; we never deploy a code change and schema change in
  the same release.

## Decisions

- **Postgres** is the durable substrate; **Redis** is hot cache and
  ephemeral state.
- **Per-org data key** for envelope encryption.
- **Row-level security** with `org_id` on every business table.
- **Postgres-backed durable queue** for tasks.
- **Append-only audit** with hash chain.
- **No down migrations**; forward-only with backfills.

## Open questions

- pgvector vs. dedicated vector store (Pinecone, Weaviate, Qdrant)
  for v2 scale. Probably pgvector survives at our v1.x scale; revisit
  if recall@k drops.
- Sharding strategy if a single org grows huge. Probably per-org
  partitioning on `org_id` as a v2 problem.
- Multi-region: Postgres logical replication for read locality vs.
  active-active. Not a v1 problem.
- Cold-storage migration for old audit events: S3 with `events_cold`
  table pointer? Probably v2.
