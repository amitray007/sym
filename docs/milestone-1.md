# Milestone 1: the spike

Goal: prove the parts the design depends on, against a test Slack workspace and a real T3 Code
worker. No production deployment and no adopter pack beyond a test pack.

## Build order

1. **Scaffold.** Done: Eve app with `eve init`, Eve pinned to 0.81.0, pnpm, Biome, Vitest, Knip,
   CI, and Postgres 18 in Docker for local work (decision 014).
2. **Worker connection.** Done over loopback (2026-10-19): the T3 adapter in `lib/workers/t3/`
   with its own MCP client (decision 015). `pnpm t3:login` signs in with T3's consent flow, and
   `pnpm t3:check` lists projects and providers. Still to do: the same check over the tailnet
   with HTTPS, which the deployment needs.
3. **Ledger.** Done: `jobs` and `outbox` tables with migrations in `lib/ledger/` (decision 016),
   and a fake worker adapter in `test/fakes/worker.ts`.
4. **`t3_job` task tool.** Code done (decision 017): the watch loop, `yield` to the status line,
   the callback URL with a timer fallback, and the duplicate-launch guard by title, tested with
   the fake worker. Live (2026-10-19): `pnpm t3:job-smoke` ran the job steps against a test
   repository. The worker committed the change, called back, and the job ended `done` with the
   output contract block. Through Eve: done locally with the fixture brain (decision 023).
5. **Slack.** Done locally against a fake Slack API (decision 023): the owner allow-list
   (`SYM_SLACK_USERS`), the brief with Start, Edit, and Cancel (decision 021), the job card with
   `chat.update` (decision 020), worker questions as buttons, the permission DM, and "what's the
   update?". Still to do: the same flow with the test Slack app.
6. **Display rule.** Done: `lib/display.ts`, and every post Sym makes goes through it and the
   outbox (`lib/jobs/present.ts`). Eve's own replies and prompts are Eve's.
7. **Recovery.** Done locally: kill `eve dev` mid-job, restart, and reconcile finishes the job
   with its card and result message (decision 022, `test/e2e/recovery.e2e.ts`).
8. **Worker environment.** Inside a T3 thread, check that the repository's own agent settings and
   folder environment apply.

## Open checks

- Does a thread started by a handler or schedule get Eve's task card?
- ~~`plan` block status values and `chat.update` rate limits.~~ `complete`, and Tier 3 (docs/slack.md).
- ~~A `taskCard` renderer that hides Eve's card for `t3_job` only.~~ Done in `agent/channels/slack.ts`.
- ~~Does `createWebhook` return the public host or the private host?~~ Neither: off Vercel it
  returns `localhost:3000`. Sym rebases it on `SYM_CALLBACK_URL` (decision 028).
- Does `ctx.send` work from `onSlashCommand`?
- ~~Does Eve accept the T3 OAuth flow through `defineInteractiveAuthorization`?~~ Not used: it is
  user-scoped, and reconcile runs without a user (decision 015).
- Does the build-time pack overlay compile pack playbooks (see [adopting.md](adopting.md))?

## Exit criteria

`pnpm test:e2e` checks criteria 1 to 5 against fakes, and CI runs it on every push. A live run
with the test Slack app and a real worker is still to do.

1. A Slack mention produces a brief with Start, Edit, and Cancel. Start launches exactly one T3
   thread, even when the launch step re-runs.
2. The job card shows live steps and updates only by edits while the job runs. The thread gets
   one new message at the start and one at the end.
3. A question from the worker agent arrives as Slack buttons, and the answer reaches the thread.
4. A permission block produces one DM to the owner.
5. After a process restart mid-job, reconcile re-attaches and the job finishes with a correct
   result message.
6. `chooseDisplay` unit tests pass for every step and modifier, and a clean scheduled check posts
   nothing.
7. CI runs lint, typecheck, tests, and Knip on every push.

## After milestone 1

Deployment to the reference host, the dispatcher and schedules, memory, feedback buttons, the
digest, and evals. Record each result of the open checks as a decision.
