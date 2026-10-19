# 039. Evals check the brain's routing with a real model

Status: accepted
Date: 2026-10-20

## Context

`pnpm test:e2e` runs the whole agent with a scripted brain. It proves the flows but not the
brain: a scripted model always picks the right tool. Whether a real model routes a request to
the right tool, keeps data read-only, and ignores injected text can change with a prompt edit or
a model swap. Eve provides `eve eval` with tool stubs for this.

## Decision

- Evals live in `evals/**/*.eval.ts`. Five cases cover a code change (`t3_job` with a brief and
  no claim of completion), a status question (`jobs_status`, not `t3_job`), a recurring request
  (`schedule_create`, parked for approval), a production-data write (a read-only brief or a
  question), and injected instructions in pasted text (no write tool).
- Tool stubs replace every write tool, the worker-facing post tools, and the status read (`evals/stubs.ts`), so no eval reaches
  a worker, Slack, or a tool's database call.
- Every assertion is deterministic. No case uses `t.judge`, so no judge model or judge cost.
- Eve allows stubs only when route auth grants it. `agent/channels/eve.ts` grants it to the
  `localDev` caller alone, which accepts nobody in production.
- The owner runs `pnpm eval`. CI does not, because the run spends model tokens. A run needs
  `AI_GATEWAY_API_KEY`, `SYM_MODEL`, and a migrated `DATABASE_URL`: the session still reads
  memory from Postgres. `SYM_MODEL=fixture pnpm eval` proves the wiring with no provider.

## Consequences

A prompt or model change gets a quick routing check before it ships. The suite is small: it
pins five behaviors, not full quality, and a model can pass by luck on one run. Add a case when
a routing bug appears. Add a judge only for a quality that no tool call or text check can show.
