import type { Migration } from "../ledger/migrations.ts";

// Decision 088: a trigger is a schedule fired by a Slack event in a watched channel: a new
// top-level message (with optional keywords) or a reaction with one emoji. A run of a trigger is
// a row in `schedule_runs`, like a scheduled run, so the run binding, the outcomes, the digest,
// and the creator lookup serve both. A run belongs to exactly one schedule or one trigger.
export const channelTriggersMigration: Migration = {
  version: "037_channel_triggers",
  sql: `
    create table triggers (
      id bigint generated always as identity primary key,
      kind text not null check (kind in ('message', 'reaction')),
      -- The watched channel. Slack sends events only from channels Sym is in.
      channel text not null check (channel ~ '^[CG][A-Z0-9]+$'),
      -- A message trigger fires only when the text has one of these words. Empty means any.
      keywords text[] not null default '{}',
      -- A reaction trigger fires on this emoji name, without colons or skin tone.
      emoji text,
      title text not null,
      instruction text not null check (length(trim(instruction)) > 0),
      builder text not null default 'ask' check (builder in ('ask', 'auto')),
      -- Where runs post: null is the event message's thread; else a channel or DM channel ID.
      destination text,
      owner text not null,
      status text not null default 'active' check (status in ('active', 'paused', 'deleted')),
      created_at timestamptz not null default now(),
      constraint triggers_emoji check (coalesce((kind = 'reaction') = (emoji is not null), false))
    );
    create index triggers_watch on triggers (channel, kind) where status = 'active';

    alter table schedule_runs alter column schedule_id drop not null;
    alter table schedule_runs add column trigger_id bigint references triggers (id);
    -- One run per trigger and Slack event, so a retried event does not fire twice.
    alter table schedule_runs add column event_key text;
    -- The event facts, and where a deferred run starts its session.
    alter table schedule_runs add column event jsonb;
    -- A run the per-minute dispatcher still has to send.
    alter table schedule_runs add column deferred boolean not null default false;
    alter table schedule_runs add constraint schedule_runs_source
      check (coalesce((schedule_id is null) <> (trigger_id is null), false));
    alter table schedule_runs add constraint schedule_runs_trigger_event
      check (coalesce(trigger_id is null or event_key is not null, false));
    create unique index schedule_runs_trigger_event_key on schedule_runs (trigger_id, event_key)
      where trigger_id is not null;
    create index schedule_runs_trigger_fired on schedule_runs (trigger_id, fired_at)
      where trigger_id is not null;
    create index schedule_runs_deferred on schedule_runs (fired_at) where deferred;
  `,
};

// Decision 088, hardening. A deferred run's claim expires, so a dispatcher that crashes between
// the claim and the send leaves the run for the next tick, which sends it with the same delivery
// key. A thread remembers that a person talked to Sym there, so a silent run's rule ends.
export const triggerRunLeaseMigration: Migration = {
  version: "038_trigger_run_lease",
  sql: `
    alter table schedule_runs add column deferred_until timestamptz;
    alter table session_threads add column person_turn boolean not null default false;
  `,
};
