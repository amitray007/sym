# 054. The digest, the verifier, and PR follow are opt-in

Status: accepted
Date: 2026-10-21

## Context

Three features acted on their own with no switch of their own. The daily digest (decision 024)
posted whenever a digest channel was set, and that channel also carries the weekly `learn`
proposals. The verifier (decision 032) made a paid model call on every finished code job. PR follow
(decision 034) asked the worker to watch each job's PR and posted every wake. An owner could not
keep the learn proposals without the digest, or run jobs without the extra model call and posts.

## Decision

1. Each feature has an environment switch, and each is off by default:
   - `SYM_DIGEST=on` posts the daily digest. It still needs a digest channel. `learn` and the
     sign-in notice use the channel without the switch.
   - `SYM_VERIFIER=on` runs the `verifier` subagent on a finished code job. Off, the job ends with
     the rule checks alone, and its result has no verifier line.
   - `SYM_PR_FOLLOW=on` lets reconcile ask the worker to watch a job's PR and post its wakes.
2. One reader, `envSwitch` in `lib/env-switch.ts`, parses every switch. `on`, `true`, `1`, and
   `yes` turn a switch on; `off`, `false`, `0`, and `no` turn it off, in any case. Anything else
   keeps the default. `SYM_FEEDBACK` (decision 047) and `SYM_STRANGER_REPLIES` (decision 053) use
   it too, with their default of on. `SYM_STRANGER_REPLIES` now also accepts `false`, `0`, and `no`.
3. The verifier switch is read inside the `check` step, so a replay of the `worker_job` body sees
   the same value.

## Consequences

With the digest off, a scheduled check that passes posts nothing anywhere (decision 031). It shows
only as a finished job in `/sym status`, for 24 hours. With PR follow off, a PR that fails CI after
its job ends gets no post; the owner watches it on GitHub. A PR that reconcile already asked the
worker to watch stays watched on the worker after the switch goes off, but Sym posts no new wakes.
The end-to-end harness sets `SYM_VERIFIER=on`, because its scenarios cover the verifier.
