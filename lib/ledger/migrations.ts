// Ledger migrations, applied in order by `migrate`. Never edit a migration after it ships. Add a
// new one. The SQL lives in TypeScript so the Eve build bundles it.

import {
  connectionDefaultModeMigration,
  connectionInstructionsMigration,
  connectionsMigration,
} from "../connections/migration.ts";
import { jobCodeChannelMigration } from "../jobs/code-channel-migration.ts";
import { workerIdentityMigration } from "../jobs/policy-migration.ts";
import { workerCapabilitiesMigration } from "../jobs/worker-capabilities-migration.ts";
import {
  learningMigration,
  repeatSourceMigration,
  trustLadderMigration,
} from "../learning/migration.ts";
import { memoryMigration } from "../memory/migration.ts";
import { quietMigration } from "../quiet/migration.ts";
import { reactionsMigration } from "../reactions/migration.ts";
import { schedulePackKeyMigration, schedulesMigration } from "../schedules/migration.ts";
import { scheduleRunsMigration } from "../schedules/runs-migration.ts";
import { credentialsMigration } from "../workers/credentials-migration.ts";
import { workerMigration } from "../workers/migration.ts";

export interface Migration {
  version: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: "001_jobs_and_outbox",
    sql: `
      create table jobs (
        id bigint generated always as identity primary key,
        -- The replay-stable tool call ID. A re-run launch step finds its row instead of adding one.
        request_key text not null unique,
        session_id text,
        kind text not null,
        title text not null,
        status text not null default 'launching' check (status in (
          'launching', 'running', 'waiting_input', 'waiting_permission', 'quiet',
          'worker_offline', 'checking', 'done', 'failed', 'cancelled'
        )),
        owner text,
        slack_channel text,
        slack_thread_ts text,
        brief jsonb not null,
        worker text not null,
        worker_project_id text,
        worker_thread_id text,
        cursor text,
        last_summary text,
        -- The newest worker message. At the end it holds the output contract block.
        last_message text,
        card_ts text,
        display jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        finished_at timestamptz
      );

      create unique index jobs_worker_thread on jobs (worker, worker_thread_id)
        where worker_thread_id is not null;
      create index jobs_active on jobs (status)
        where status not in ('done', 'failed', 'cancelled');

      create table outbox (
        id bigint generated always as identity primary key,
        idempotency_key text not null unique,
        job_id bigint references jobs (id),
        method text not null check (method in ('chat.postMessage', 'chat.update')),
        payload jsonb not null,
        -- Every post carries the chooseDisplay result. Level 0 means post nothing. A missing key
        -- makes the expression NULL, and a CHECK passes on NULL, so coalesce it to false.
        display jsonb not null check (coalesce(
          jsonb_typeof(display -> 'level') = 'number'
          and (display ->> 'level')::int between 1 and 4
          and display ->> 'target' in ('thread', 'dm')
          and jsonb_typeof(display -> 'reason') = 'string',
          false
        )),
        status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
        attempts int not null default 0,
        last_error text,
        slack_ts text,
        created_at timestamptz not null default now(),
        sent_at timestamptz
      );

      create index outbox_pending on outbox (created_at) where status = 'pending';
    `,
  },
  {
    version: "002_threads_cards_leases",
    sql: `
      -- The Slack thread each Eve session talks in. The Slack renderer records it, because tools
      -- and schedules cannot read the channel's own session state.
      create table session_threads (
        session_id text primary key,
        team_id text,
        channel_id text not null,
        thread_ts text,
        user_id text,
        updated_at timestamptz not null default now()
      );

      -- The job card is Sym's own message. The row holds the card Sym wants to show, and the
      -- version Slack shows, so any process can bring Slack up to date.
      alter table jobs add column card jsonb;
      alter table jobs add column card_version int not null default 0;
      alter table jobs add column card_sent_version int not null default 0;
      alter table jobs add column pr_url text;
      alter table jobs add column started_at timestamptz;
      alter table jobs add column last_activity_at timestamptz;
      alter table jobs add column quiet_noticed_at timestamptz;
      -- The watcher lease. A worker_job task renews it on each check. Reconcile takes over a job
      -- whose lease ran out, for example after the session died.
      alter table jobs add column watch_until timestamptz;

      alter table outbox add column purpose text not null default 'message'
        check (purpose in ('message', 'card'));
      -- A sender claims a post before it calls Slack, so two senders do not send it twice.
      alter table outbox add column claimed_until timestamptz;
    `,
  },
  // Later migrations live next to the code that owns their tables.
  schedulesMigration,
  memoryMigration,
  quietMigration,
  learningMigration,
  workerMigration,
  credentialsMigration,
  scheduleRunsMigration,
  {
    version: "010_job_revision_verdict",
    sql: `
      -- Every update bumps the revision, so a slow check that read an older revision cannot
      -- overwrite a newer state, status-only changes included (decision 037).
      alter table jobs add column revision int not null default 0;
      -- The model check's outcome, kept before the job is marked done, so recovery keeps it.
      alter table jobs add column verdict jsonb;
      -- Set when the job's end was presented, silent or not. Reconcile recovers the rest.
      alter table jobs add column end_presented_at timestamptz;
    `,
  },
  {
    version: "011_job_worker_model",
    sql: `
      -- The model the worker thread runs, as <provider>/<model> (decision 041).
      alter table jobs add column worker_model text;
    `,
  },
  connectionsMigration,
  {
    version: "012_settings_updated_by",
    sql: `
      -- Who last changed a setting, for the ones set from Slack, such as the persona (decision 046).
      alter table settings add column if not exists updated_by text;
    `,
  },
  connectionInstructionsMigration,
  connectionDefaultModeMigration,
  reactionsMigration,
  {
    version: "016_thread_listen",
    sql: `
      -- How Sym listens in one Slack thread: 'all' or 'mention-only' (decision 050). Kept per
      -- thread, so it outlives the session. No row means 'all'.
      create table thread_listen (
        channel_id text not null,
        thread_ts text not null,
        mode text not null check (mode in ('all', 'mention-only')),
        updated_by text,
        updated_at timestamptz not null default now(),
        primary key (channel_id, thread_ts)
      );
      -- The person Sym last served in a thread is the latest session_threads row with a user.
      create index session_threads_thread on session_threads (channel_id, thread_ts, updated_at desc);
    `,
  },
  schedulePackKeyMigration,
  {
    version: "019_job_pr_facts",
    sql: `
      -- The pull request facts the worker reported when the job ended, kept so a re-presented
      -- result shows the same checks without another worker call (decision 057).
      alter table jobs add column pr_facts jsonb;
    `,
  },
  repeatSourceMigration,
  {
    version: "018_job_followups",
    sql: `
      -- A Fix from the result message continues the job's worker thread as a new job
      -- (decision 056). Close marks a finished job as settled by a person.
      alter table jobs add column parent_job_id bigint references jobs (id);
      alter table jobs add column closed_at timestamptz;
      alter table jobs add column closed_by text;
      -- A follow-up shares its parent's worker thread, so a thread can hold several jobs. Only
      -- one of them may be active at a time: their results must not mix.
      drop index jobs_worker_thread;
      create unique index jobs_worker_thread_active on jobs (worker, worker_thread_id)
        where worker_thread_id is not null and status not in ('done', 'failed', 'cancelled');
    `,
  },
  trustLadderMigration,
  workerIdentityMigration,
  workerCapabilitiesMigration,
  jobCodeChannelMigration,
];
