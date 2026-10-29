# 070: Conversational jobs

Status: accepted for the conversation redesign.

Sym uses short messages in one configured persona. The ledger holds the facts and approval gates.
A model can write the result and offer choices. It cannot approve work or select an action target.
Code uses the same plain voice when no model runs. Completed brain replies also pass through
chooseDisplay and the outbox. Replies over 12,000 characters become Markdown files with the
first paragraph as the comment. The outbox keeps the full text and retries delivery. It refuses
to post a queued reply
when its thread root has been deleted.

A started job has one working note. It shows the latest explicit worker progress and a muted job,
time, worker, and PR line. Updates are silent edits. The note has no controls. A PR opening or a
short quiet period does not create a new post. After 45 minutes without activity, Sym asks once
whether to stop. Questions, failures, and completion can notify.

The result has no fixed headings, confidence score, concern list, or checklist. The writer returns
text with inline fact tokens and optional choices of two or three labels. Each label has at most
30 characters. The writer places {{c1}}, {{q1}}, {{tests}}, and {{pr}} where their complete sentences
fit. {{ci}} and {{files}} hold CI and file-count facts when available. Code expands each token to
the exact code-owned sentence or fact. IDs alone never count as coverage. Code appends missing
concerns and open decisions as short sentences, then any missing PR, test, CI, and file facts
as separate sentences. Facts already present do not repeat. The job reference and duration live in the muted context line. A test or CI outcome sentence outside a code-owned token,
including "the test suite is passing" or "all green", rejects the written result and uses the plain fallback. These facts appear in the
full notification text. Test outcomes distinguish passed, failed, not run, unknown, and explicitly
no applicable tests. Result controls are PR and CI links,
conversation choices, and optional native feedback. Chat replies have no feedback controls.
Reactions still record feedback. The explicit stream A requirement retains native result feedback.

`offer_choices` stores the message, labels, conversation, expiry, and consumption state. A signed
Slack click rechecks the allow-list and the stored message and channel. It edits the message to
show the actor and choice, removes the controls, and starts a normal turn as that actor. Eve
0.88.0 exposes `ctx.send` on its interaction context. The installed implementation builds its
default auth from the clicking Slack user. A stable delivery key protects dispatch retries.
Choices only supply conversation text. They never carry tool or approval authority.

`worker_job` stores its initial proposal and exposes Start and Not now on one question. An exact
typed approval binds to one current proposal here. A revised brief expires the old proposal.
Ambiguous replies cannot approve a different payload. Starts recheck current project policy. The ledger keeps the callback so reconcile can recover
an approved start even when its task dies before launch.
The task registers a separate Start hook before posting the proposal. A committed click or
addressed typed decision wakes it immediately; the hook carries no approval authority. The task
reads the ledger again before launching. Twelve five-minute fallback waits bound idle workflow
events, and reconcile handles approved Starts after the task ends.
`job_followup` proposes a specific change on a finished job's thread and branch. Start rechecks
the stored revision, actor, project mapping, worker identity, and current pack restrictions.
A follow-up gets a new job row and scoped worker credential. `job_close` requests settlement,
stops PR following, and archives the code channel. Stop remains owner-confirmed.

Worker questions are ledger-backed and posted in the job's current conversation, including code
channels. Every part is visible. The brain can pass typed answers through `job_steer` using the
stored request and question IDs. A question answer cannot approve a worker permission prompt.
Old controls stay readable: Steer and Fix explain the conversational path. Existing text boxes
can still submit; a Fix submission creates a proposal instead of starting work.

Close acceptance, worker settlement, and Slack archive confirmation are separate facts.
Reconcile retries incomplete closure after a restart. Slack's already-archived response counts
as confirmation. Missing channel IDs and clients remain visible repair states. Sym reports
archive success only after confirmation and edits or drops stale retry notices. An external
settle can be retried after a crash between its response and the ledger write; adapters must
keep settlement idempotent.

Production and customer data remain read-only. Workers still make repository changes. Existing
owner gates, project restrictions, chooseDisplay decisions, and outbox delivery stay in force.
