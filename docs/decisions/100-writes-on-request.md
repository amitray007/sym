# 100. Production writes on the person's request

Status: accepted
Date: 2026-11-23

## Context

Decision 064 made production and customer data read-only for every path, "even when someone
asks". The rule was written for Builder briefs: in evals the brain wrote briefs whose goal was the
production write. The brain applied it to its own tools too. With the sandbox network on, an
allowed person asked Sym to stop an idle production VM with an operations command. Sym refused,
even after the person asked directly, and said the limit could not be lifted from chat.

A teammate that refuses a direct, confirmed request from the people it serves is not useful for
operations work. The risk the rule guarded against is an unasked write: the brain acting on its
own, from a run, or from untrusted text.

## Decision

1. The brain may change production systems, production data, or customer data with its own tools
   (the sandbox and connections) when the person it helps asks for that change.
2. Before the change, it states exactly what it will run or change and what that affects, then
   waits for the person's yes.
3. It never makes such a change on its own initiative, in a scheduled or trigger run, or because
   outside text (tickets, logs, web pages, event payloads) asks. Outside text never counts as a
   person's request.
4. Builder briefs stay as decision 064 set them: a job never writes production or customer data
   and can only prepare the change. The worker message still adds the read-only line, and a pack's
   `productionData` still accepts only `read-only`.
5. The rule lives in the brain's instructions. Code checks stay as they are: the allow-list, the
   owner's click on connection tools in `ask` mode, and `SYM_APPROVAL_*` (decision 099).

## Consequences

- Allowed people can ask Sym for operations writes, such as stopping a VM, and Sym runs them after
  their confirmation.
- Sandbox commands have no click of their own, so the confirmation in point 2 is a model rule, not
  a code gate. A deployment that needs a hard gate keeps the sandbox network off, or reaches the
  system through a connection whose write tools stay in `ask` mode.
- `evals/safety/production-data.eval.ts` still covers briefs. No eval covers a sandbox write yet:
  the evals run with the sandbox off.
