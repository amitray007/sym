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
[ Stop ]  [ Open PR ]
```

- The card is a Slack `plan` block. Each row is a step with a status: `pending`, `in_progress`,
  `complete`, or `error`. A plan holds at most 50 rows. Each edit uses a new `block_id`, because
  Slack redraws a plan block only under a new one; the version moves only when the card changes.
- The job row holds the card Sym wants. Delivery posts it and edits Slack to match (decision 020).
- Sym fills the steps from the brief's done-when list and the worker activity it reads.
- Slack text calls the worker by `SYM_WORKER_LABEL` (default `Worker`) and never names the software behind it (decision 044). The mockups show the label `Builder`.
- Sym's renderer removes `worker_job` rows from Eve's task card, and returns `null` when nothing else
  is left, so the thread has one card.
- When the job ends, the card collapses to one line, for example "Done in 14m · PR #812", and the
  result posts as text.

## Surfaces

| Surface | What Sym shows | Driven by | When |
|---|---|---|---|
| Thread status line | "Launching worker thread", "Tests running" | Eve: `label.start`, `label.delta`, task `yield` | Milestone 1 |
| Job card (`plan` block) | Live steps with Stop and Open PR. Steering is a thread reply | Sym: `chat.update` | Built |
| Eve task card | Short tasks that are not worker jobs | Eve | Milestone 1 |
| Buttons and selects | Approve a brief, answer worker questions, approve rules | Eve: approvals, `ctx.ask` | Milestone 1 |
| "Type your answer" modal | Free-text answers | Eve, inside `ctx.ask` | Milestone 1 |
| Feedback buttons | 👍/👎 inside each final reply | Sym: renderer posts the reply with a `context_actions` block | Built |
| Status reactions | 👀 picked up, ✅ done, ⚠️ needs you | Sym: `reactions.add` | Later |
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
- Slack's reference uses `complete`; `completed` appears only in guide prose. Sym sends
  `complete`. `chat.update` is Tier 3 (50 or more per minute).

## Voice

Sym's messages are short and structured, so they scan in a glance. Two parts make them, and only
one has a persona (decision 044).

- **Sym's code** builds the brief, the card, the result, failures, and status answers. These are
  neutral and never joke. The result message has this shape:

  ```
  ⚠️ *J-3 · Review PR #7698 data:null fix* · 1m
  *tl;dr* Merge PR #7698: the one-line fix is correct.

  *⚠️ check before merge* (75% sure)
  1. The worker opened a pull request the job did not allow.
  2. Tests were not run, so fail-before / pass-after is unverified.

  *open questions*
  ☐ Follow-up issue for the other .get('data', {}) sites?

  🔗 <PR #7698> · tests: not run
  ```

  The emoji is ✅ for a clean result, ⚠️ for concerns, and ❌ for a failure. The tl;dr is the
  summary's first sentence, capped near 160 characters. Concerns repeat nowhere: Sym drops near
  duplicates, and drops an open question that a concern already covers. The footer holds the PR
  link, the tests line, and the file count. The worker thread ID shows only when there is no
  result to read, or on a failure.
- **The brain** writes every other reply: answers, questions, status summaries. It follows the
  shared Voice rules in `agent/instructions.md`: the answer first in one line, then numbered
  steps, bullets, or `☐`/`✅` checklists, about 6 lines at most, bold on the key word only. It
  never repeats a Sym post. A `worker_job` result carries `posted: true`, and the brain then calls
  `no_reply`.

`SYM_PERSONA` picks the brain's tone: `plain` (neutral), `casual` (default: relaxed, lowercase
friendly, at most one emoji), or `spicy` (playful, may lightly tease the person talking to Sym,
with hard limits in `agent/personas/spicy.md`). A pack can supply its own persona file. Worker
threads never get a persona.

## Slash command, card buttons, and feedback

- `/sym status` and `/sym jobs` answer privately (ephemeral) with one line per active job and per
  job finished in the last 24 hours, plus the quiet state. `/sym quiet [minutes|2h]` stays silent
  for that long (default 60 minutes, at most 7 days); `/sym quiet off` ends it. Only allowed
  users can run it, and no model call is made.
- The live card has **Stop** (with a confirm step; the worker is interrupted and the job
  cancelled) and, once a PR is known, **Open PR**. The collapsed card keeps only **Open PR**.
  Steering is a thread message for now; a modal button comes later.
- Each final reply carries Slack's feedback buttons in the same message, so they add no
  notification. A reply Slack refuses as blocks goes out as plain Markdown or a snippet without
  them. Clicks and reactions on Sym's messages go to the `feedback` table, and Sym uses them only
  after review (docs/learning.md).

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
| `assistant:write` | The thread status line (`assistant.threads.setStatus`) |
| `reactions:read`, `reactions:write` | Feedback reactions in; status reactions out (later) |
| `commands` | `/sym` |
| `users:read` | Resolve the approver for DM routing |

Events: `app_mention`, `message.im`, `message.channels`, `message.groups`, `reaction_added`.
Interactivity and the slash command use the same request URL, `/eve/v1/slack`. The Home tab and
`app_home_opened` come with team use. To post the digest in a channel, invite Sym to it first;
the manifest has no `chat:write.public`.

Allow-list: the pack's owner and `allowList`, or `SYM_SLACK_USERS` without a pack. Approvals
(tool approvals such as schedules, playbooks, and Stop) count only from the owner: the pack owner,
else `SYM_OWNER_SLACK_USER`. Questions, including Start, Edit, and Cancel, stay open to allowed
users. Every inbound
handler checks it and fails closed, including answers to buttons. Thread context still includes
messages from other people in the thread. The instructions treat that text as data, and job
launches need approval.
