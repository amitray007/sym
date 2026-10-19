# Slack

Slack has native parts for agent apps: a thread status line, task and plan blocks, feedback
buttons, and an agent surface. Eve drives some of them. Sym's own code drives the rest through
`ctx.slack.request` and `callSlackApi`. [display.md](display.md) decides which part each message
uses.

## The job card

Eve's task card shows one row per task: title, working or waiting, and the end state. It shows no
progress inside a job, and schedule sessions get no card. So each long job gets one message that
Sym owns. Sym posts it when the job starts and edits it with `chat.update` from the watch loop and
from reconcile. Its `ts` lives on the ledger row, so the card keeps updating after a session dies
and for scheduled jobs.

```
[J-142] Billing sync retry · running 14m
  ✓ Brief approved
  ✓ Worker thread started (worktree in sync-service)
  ◐ Writing code: 3 files changed
  ○ Tests
  ○ Draft PR
  ○ Verify result
Codex · thread 8f2c… · updated 1 min ago
[ Steer ]  [ Stop ]  [ Open PR ]
```

- The card is a Slack `plan` block. Each row is a step with a status: pending, in progress, done,
  or error.
- Sym fills the steps from the brief's done-when list and the worker activity it reads.
- A `taskCard` renderer that returns `null` hides Eve's own card for `t3_job` tasks, so the thread
  has one card.
- When the job ends, the card collapses to one line, for example "Done in 14m · PR #812", and the
  result posts as text.

## Surfaces

| Surface | What Sym shows | Driven by | When |
|---|---|---|---|
| Thread status line | "Launching worker thread", "Tests running" | Eve: `label.start`, `label.delta`, task `yield` | Milestone 1 |
| Job card (`plan` block) | Live steps with Steer, Stop, Open PR | Sym: `chat.update` | Milestone 1 |
| Eve task card | Short tasks that are not worker jobs | Eve | Milestone 1 |
| Buttons and selects | Approve a brief, answer worker questions, approve rules | Eve: approvals, `ctx.ask` | Milestone 1 |
| "Type your answer" modal | Free-text answers | Eve, inside `ctx.ask` | Milestone 1 |
| Feedback buttons | 👍/👎 under each final reply | Sym: renderer with a `context_actions` block | Production |
| Status reactions | 👀 picked up, ✅ done, ⚠️ needs you | Sym: `reactions.add` | Production |
| Ephemeral replies | `/sym status`, private sign-in prompts | Eve | Production |
| Long output | Over 12,000 characters as an `eve-response.md` snippet | Eve | Production |
| Modals | "New schedule" form | Sym: `views.open` with the `trigger_id` | Team phase |
| App Home tab | Running jobs, approvals, schedules, trust ladder, what Sym learned | Sym: `app_home_opened` + `views.publish` | Team phase |
| Agent surface | Top-bar entry, suggested prompts, session titles | Sym: `assistant:write`, `assistant.threads.setSuggestedPrompts` | Later |
| Streamed replies | Text as it is written | `chat.startStream` and related | Skip |

Notes:

- Eve does not document the agent surface or streaming. Both work through raw Slack API calls, but
  Eve already owns the status line and replies, so the two would conflict. The agent surface may
  also need a paid Slack plan.
- The status line is cut at 50 characters, and Slack clears it after 2 minutes without a post.
  The job card carries anything that must stay visible.
- Card posts never unfurl links. Put PR and CI links on buttons or in the card footer.
- Slack documents two sets of `plan` status values (`completed` and `complete`). Check them in
  Block Kit Builder during milestone 1.

## App setup

[`slack/manifest.yaml`](../slack/manifest.yaml) creates the app. Replace `https://sym.example.com`
with the public host before you import it.

| Scope | Why |
|---|---|
| `app_mentions:read` | `@sym` in channels |
| `chat:write` | Replies, job cards, card edits |
| `im:history`, `im:read`, `im:write` | DMs and approval DMs |
| `channels:history`, `groups:history` | Replies in job threads without a mention |
| `files:read`, `files:write` | Logs and screenshots in; long reports out |
| `reactions:read`, `reactions:write` | Feedback reactions in; status reactions out |
| `commands` | `/sym` |
| `users:read` | Resolve the approver for DM routing |

Events: `app_mention`, `message.im`, `message.channels`, `message.groups`, `reaction_added`,
`app_home_opened`. Interactivity and the slash command use the same request URL,
`/eve/v1/slack`.

Milestone 1 allow-list: the owner's Slack user ID only, in `SYM_SLACK_USERS`. Every inbound
handler checks it and fails closed, including answers to buttons. Thread context still includes
messages from other people in the thread. The instructions treat that text as data, and job
launches need approval.
