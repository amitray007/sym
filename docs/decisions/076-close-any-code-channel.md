# 076. Close any code channel

Status: accepted
Date: 2026-10-30

An allowed person can say "close this channel" in any code channel. `job_close` takes an
optional job handle. Without one, it uses the current session's Slack channel. Both chat and
context-bar clicks use `closeCodeChannel`. Answers say "this" or name the work by title.

A job channel uses the existing `closeJob` path: running work refuses until stopped, and
finished work settles its worker, stops PR following, and archives. The ledger keeps each
confirmed step and reconcile retries missing steps.

A conversation channel has no job row. Sym checks `record_type === "agent_channel"` through
`conversations.info`, then calls `agents.conversations.archive` without a summary. It reports
archive success only after Slack confirms it. An archived channel says "Already closed."
An advisory lock serializes the info/archive pair across processes. Slack failures return
"Slack refused: <code>." There is no ledger retry for these channels; the person can ask again.

The job context bar ends with a Close channel action after its project and PR. Each write
replaces the whole bar and contains at most three items. Eve's installed `openCodeChannel`
returns only `status` and `sessionId`, with no channel ID. So the first turn Sym handles in a
conversation channel sets a bar with only the Close item, once per process. Slack keeps the bar,
and a repeat after a restart rewrites the same item. A job started there later replaces it with
the job bar.

Slack [documents action items](https://docs.slack.dev/ai/slack-code/code-channel-properties/)
and a `code_channel_action` event, but does not document its payload. Sym accepts channel/user
IDs under either short or `_id` fields and the item key under `key`, `item_key`, `action_id`,
`item.key`, or `action.key`. Unknown keys do nothing. An unreadable shape logs its field names
only. The owner must confirm the payload in a live check after updating the event subscription.

Both paths check the pack or environment Slack allow-list. A denied click sends only a private
ephemeral refusal. Allowed click answers use `chooseDisplay` and the outbox. Local checks use
fakes. The routing eval is owner-run and is not part of local checks.
