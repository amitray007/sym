# 073. Name the work

Status: accepted
Date: 2026-10-30

People see a job or schedule's title. In its own thread or code channel, Sym says "this", "it",
or just the result. Owner DMs, Home, digests, status lists, learning evidence, and recovery
refusals use titles linked to the conversation when its channel and thread are known.
Working notes keep time, worker, and PR facts. Result context keeps time. Neither shows a job
reference. Full briefs start with the goal.

Job and schedule references remain tool handles. Sym accepts one a person types. Structured
outputs keep the handles the brain needs for actions. Worker messages, recovery title prefixes,
request keys, block and action IDs, tokens, and logs keep their references.

Code channels use the title alone. An explicit `name_taken` refusal retries once with a numeric
suffix, such as `Billing sync retry #142`, within the existing name limit. The retry keeps the
same session ID, origin, and privacy. Other refusals keep the job in its thread. Slack documents
`name_taken` for [conversations.create](https://docs.slack.dev/reference/methods/conversations.create.md).
The [code-channel create page](https://docs.slack.dev/reference/methods/agents.conversations.create.md)
does not list a name-collision code. Sym handles an explicit `name_taken` response without treating
other creation failures as collisions. The context bar keeps the project and PR.

The writer gets the title without the job handle. Its instructions forbid references, and a
written result containing one uses the plain fallback. A voice eval checks that a status reply
contains no job handle. Local checks use fakes; the owner runs model evals.

Owner approval prompts read only the tool input, so they cannot look up a title. `job_stop` and
`schedule_delete` take the exact title next to the reference, and the prompt shows it, such as
`Stop "Billing sync retry"?`. Execute refuses when the title differs from the stored row, the
same check `schedule_approve` does for its brief. The owner always sees what they approve.

This updates the presentation rules in decisions 070 and 071. Recovery and approval rules stay
in force. `docs/mockups/index.html` and `docs/mockups/conversational.html` show titles in every
message, card, Home row, and code-channel name.
