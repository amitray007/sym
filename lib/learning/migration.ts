import type { Migration } from "../ledger/migrations.ts";

// Layer 2 playbooks and rules (docs/learning.md). lib/ledger/migrations.ts lists this migration.
// A name keeps every version it ever had. Only the approved version loads into a session.
export const learningMigration: Migration = {
  version: "006_playbooks",
  sql: `
    create table playbooks (
      id bigint generated always as identity primary key,
      name text not null check (coalesce(name ~ '^[a-z0-9][a-z0-9-]{0,63}$', false)),
      kind text not null check (coalesce(kind in ('playbook', 'rule'), false)),
      body text not null check (coalesce(length(body) between 1 and 2000, false)),
      status text not null default 'proposed'
        check (coalesce(status in ('proposed', 'approved', 'rejected', 'retired'), false)),
      version int not null check (coalesce(version >= 1, false)),
      source text not null check (coalesce(source in ('owner', 'learn'), false)),
      -- Feedback ids that led to a learned proposal.
      evidence jsonb not null default '[]' check (coalesce(jsonb_typeof(evidence) = 'array', false)),
      proposed_at timestamptz not null default now(),
      decided_by text,
      decided_at timestamptz,
      -- A decided row says who decided and when.
      check (coalesce(
        status = 'proposed' or (decided_by is not null and decided_at is not null), false)),
      unique (name, version)
    );
    -- One approved version per name at a time.
    create unique index playbooks_one_approved on playbooks (name) where status = 'approved';
    create index playbooks_status on playbooks (status, id);
  `,
};

// Repeated-work proposals (decision 058). Their evidence holds job IDs, not feedback IDs.
export const repeatSourceMigration: Migration = {
  version: "020_playbook_repeat_source",
  sql: `
    alter table playbooks drop constraint playbooks_source_check;
    alter table playbooks add constraint playbooks_source_check
      check (coalesce(source in ('owner', 'learn', 'repeat'), false));
  `,
};
