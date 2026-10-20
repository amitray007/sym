# 043. Slack shows the worker under a label

Status: accepted
Date: 2026-10-20

## Context

Sym runs jobs on a worker. The first worker is T3 Code. The owner does not want Slack to
advertise the software behind the worker. Job cards, messages, and the brain's replies named it.

## Decision

Everything a Slack user sees calls the worker by a label. The env var `SYM_WORKER_LABEL` sets it.
The default is `Worker`. The label is trimmed and cut at 30 characters.

- `lib/worker-label.ts` holds `workerLabel()` ("Builder") and `workerNoun()` ("builder", for
  mid-sentence use). It is pure, so a workflow body can reach it.
- Job cards, status answers, notices, the sign-in DM, and the tool results the brain relays use
  the label. Wording that says "the worker" today stays the same under the default label.
- A dynamic instruction (`agent/instructions/worker-label.ts`) gives the brain the label. It
  tells the brain to call the worker by that name, never name the software that runs it, even
  if asked, and never mention tool names to people.
- Code, env var names (`T3_MCP_URL`, `T3_TOKEN`), logs, and docs keep the real names. The
  ledger's `worker` column values do not change.
- The brain tool `t3_job` is now `worker_job`. Earlier decision records keep the old name.
- An end-to-end test runs a full job with the label `Builder` and checks that no Slack call
  contains "T3".

## Consequences

- The label hides the name from Slack text. It does not stop a worker thread's own text from
  naming its software, because that text is the worker's result.
- A pack field for the label is not needed now.
