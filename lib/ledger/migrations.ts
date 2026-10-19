// Ledger migrations, applied in order by `migrate`. Never edit a migration after it ships. Add a
// new one. The SQL lives in TypeScript so the Eve build bundles it.

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
];
