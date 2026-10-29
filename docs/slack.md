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
| Job card (`plan` block) | Live steps with Steer, Stop, and Open PR. Steering also works as a thread reply | Sym: `chat.update` | Built |
| Eve task card | Short tasks that are not worker jobs | Eve | Milestone 1 |
| Buttons and selects | Approve a brief, answer worker questions, approve rules | Eve: approvals, `ctx.ask` | Milestone 1 |
| "Type your answer" modal | Free-text answers | Eve, inside `ctx.ask` | Milestone 1 |
| Feedback buttons | 👍/👎 inside each final reply | Sym: renderer posts the reply with a `context_actions` block | Built |
| Reactions | A rare emoji on a person's message: 😂 funny, 💡 good idea, 🙌 good news, 🫡 ack. Never 👀, never on every message (decision 051) | Brain: `slack_react` and `slack_emoji`, limits in code | Built |
| Ephemeral replies | `/sym status`, private sign-in prompts, stranger lines | Eve, Sym | Production |
| Long output | Over 12,000 characters as an `eve-response.md` snippet | Eve | Production |
| Modals | "New schedule" form | Sym: `views.open` with the `trigger_id` | Team phase |
| App Home tab | Persona and worker state with the sign-in expiry, running and waiting jobs, jobs finished in 24 hours, schedules, the project allow-list; for the owner also MCP connections, persona, and quiet mode (decision 052) | Sym: `app_home_opened` in `onEvent` + `views.publish` on each open | Built (not run on real Slack) |
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

Two parts make Sym's messages (decisions 044 and 062).

- **Sym's code** builds the brief, the card, failures, status answers, and the template result.
  These are neutral and never joke.
- **The `writer` subagent** writes the result of a finished code job in the persona's voice,
  with no template (decision 062). It gets the persona, the owner's approved playbooks and rules,
  the job facts, the check concerns, and the worker's report as untrusted data, and picks the
  length and shape itself. Sym posts its text in a `markdown` block, then the verifier line, the
  check concerns as a numbered list, and the open questions as a `☐` checklist (so a worker
  report cannot talk them away), a `context` footer with the status emoji, `J-n`, the duration,
  the tests line, and the file count, and the result buttons. Mention tokens in the text lose
  their brackets. The
  writer runs only in the job's live session: a job that reconcile finishes, a Fix follow-up, a
  scheduled check, a writer failure or timeout (120 s), and `SYM_RESULT_WRITER=off` all get the
  template below.
- **The template result** has this shape:

  ```
  ⚠️ *J-3 · Review PR #7698 data:null fix* · 1m
  *tl;dr* Merge PR #7698: the one-line fix is correct.

  *⚠️ check before merge* (75% sure)
  1. worker opened a PR the job didn't allow.
  2. Tests were not run, so fail-before / pass-after is unverified.

  *open questions*
  ☐ Follow-up issue for the other .get('data', {}) sites?

  🔗 <PR #7698> · tests: not run
  ```

  Sym posts this as Block Kit (decision 047), with the text above as the `text` fallback for
  notifications and screen readers:

  | Block | Holds |
  |---|---|
  | `header` | status emoji, `J-n · title`, duration (150 characters at most) |
  | `section` | `*tl;dr* ...`, then the verifier line when `SYM_VERIFIER=on` |
  | `section` + `rich_text` | the concerns header, then the concerns as an ordered list |
  | `section` | `*open questions*` as a `☐` checklist |
  | `context` | the tests line and the file count |
  | `actions` | an **Open PR** link button, only when there is a PR |

  A failure is a `header` (`❌ J-n · title · failed in 14m`), a `section` with the reason, and a
  `context` with the worker thread. Sections stop at 3000 characters, lists at 10 items, and a
  cut ends with `…`. Worker text is escaped in sections and taken as typed in rich text.
  The emoji is ✅ for a clean result, ⚠️ for concerns, and ❌ for a failure. The tl;dr is the
  summary's first sentence, capped near 160 characters. Concerns repeat nowhere: Sym drops near
  duplicates, and drops an open question that a concern already covers. The footer holds the PR
  link, the tests line, and the file count. The worker thread ID shows only when there is no
  result to read, or on a failure.
- **The brain** writes every other reply: answers, questions, status summaries. The persona sets
  its voice, and it picks the length and shape that fit (decision 062). The shared Voice rules in
  `agent/instructions.md` only keep facts, refs, links, and warnings exact, and forbid repeating
  a Sym post. A `worker_job` result carries `posted: true`, and the brain then calls `no_reply`.

The persona is the pack's persona file, else the owner's `/sym persona` setting, else
`SYM_PERSONA` (the default), else `casual`. The thinking status line rotates short messages per
persona (`plain`: "Working..."; `casual`: "on it...", "thinking..."; `spicy`: "cooking...",
"reading your mess..."). The tones: `plain` (neutral), `casual` (default: relaxed, lowercase
friendly, at most one emoji), or `spicy` (playful, may lightly tease the person talking to Sym,
with hard limits in `agent/personas/spicy.md`). A pack can supply its own persona file. Worker
threads never get a persona.

## People off the allow-list

Sym never sends a message from a person off the allow-list to the brain. When such a human tags
Sym, writes to it in a direct message, or tags or names it in a thread that has a session, Sym
answers with one private (ephemeral) line that points to the owner, in the thread for a thread
reply. Untagged side talk gets nothing. A person gets at most one line per channel (or direct
message) per hour. The line follows the persona: casual and spicy personas pick a joke
(spicy 70 percent of the time), and a plain or pack persona gets "Sym only works for people on
its allow-list. Ask <owner> for access." With no owner configured, the line only says Sym works
for people on its allow-list. `SYM_STRANGER_REPLIES=off` restores the silent drop (decision 053).

## Slash command, card buttons, and feedback

- `/sym status` and `/sym jobs` answer privately (ephemeral) with one line per active job and per
  job finished in the last 24 hours, plus the quiet state. `/sym quiet [minutes|2h]` stays silent
  for that long (default 60 minutes, at most 7 days); `/sym quiet off` ends it. Only allowed
  users can run it, and no model call is made. Anyone else gets the stranger line above, with
  no cooldown (the straight line when the switch is off).
- `/sym persona` shows the brain's persona and the choices. `/sym persona <plain|casual|spicy>`
  sets it. Only the owner can set it; anyone else gets a private refusal. A pack persona file
  wins, and then Sym says so and stores nothing. The owner can also say "be spicy" or "tone it
  down" and the brain calls `sym_persona`. Either way the new persona starts in the next
  conversation (decision 046).
- The brief above the Start prompt is short: the title, the project, the delivery, the model,
  and the playbook it follows. **Full brief** sends the goal, the constraints, and the done-when
  list privately to the person who clicks (decision 060).
- The live card has **Steer**, **Stop** (with a confirm step; the worker is interrupted and the
  job cancelled), and, once a PR is known, **Open PR**. The collapsed card keeps only **Open PR**.
- The result has **Looks good**, **Fix…**, and **Close** after **Open PR**; a failure has
  **Fix…** and **Close** (decision 056). Looks good records a 👍 for the job. Close settles the
  worker thread, stops PR follow for the job, and edits the result to "Closed by @person".
  Fix starts a follow-up job on the same worker thread; the result is edited to say so, and the
  follow-up posts its own card or start line and its own result.
- **Steer** and **Fix…** post a text box in the job thread, because Eve passes no custom modal
  submission to Sym. Pressing Enter sends the text: Steer steers the running thread, and Fix sends
  a follow-up. The box then turns into the person's words and what Sym did. Allowed users can use
  every job button; answers to a click come privately.
- Each final reply carries Slack's feedback buttons in the same message, so they add no
  notification. A reply Slack refuses as blocks goes out as plain Markdown or a snippet without
  them. Clicks and reactions on Sym's messages go to the `feedback` table, and Sym uses them only
  after review (docs/learning.md). `SYM_FEEDBACK=off` removes the buttons; the handlers stay, so
  clicks on old messages still record.

## Connecting a service

The owner connects an MCP server by asking Sym, for example "connect example-tracker at
https://mcp.example.com/mcp" (decision 045).

1. Sym checks the server and shows an approval prompt in the thread: the URL, the sign-in kind,
   and every tool with read or write. Only the owner can approve it.
2. For a server that needs a token, Sym names the env var, such as
   `SYM_MCP_EXAMPLE_TRACKER_TOKEN`. The owner sets it in the deployment and redeploys. Sym never
   asks for a token in Slack.
3. For an OAuth server, Sym sends the sign-in link to the owner's DM, like the worker sign-in.
4. From the next message, people can use the service through Sym. Read tools run freely. Write
   tools show an approval prompt that only the owner can approve. The owner can set any tool to
   auto, ask, or hidden, and can remove the connection.

## App setup

[`slack/manifest.yaml`](../slack/manifest.yaml) creates the app. Replace `https://sym.example.com`
with the public host before you import it.

| Scope | Why |
|---|---|
| `app_mentions:read` | `@sym` in channels |
| `chat:write` | Replies, job cards, card edits |
| `im:history`, `im:read`, `im:write` | DMs and approval DMs |
| `channels:history`, `groups:history` | Replies in job threads without a mention, and the people in a thread |
| `files:read`, `files:write` | Logs and screenshots in; long reports out |
| `assistant:write` | The thread status line (`assistant.threads.setStatus`) |
| `reactions:read`, `reactions:write` | Feedback reactions in; Sym's own reactions out |
| `emoji:read` | The workspace's custom emoji (`emoji.list`), so Sym can pick a fitting one |
| `commands` | `/sym` |
| `users:read` | Resolve the approver for DM routing, and display names in a shared thread |

Events: `app_mention`, `message.im`, `message.channels`, `message.groups`, `reaction_added`, `app_home_opened`.
Interactivity and the slash command use the same request URL, `/eve/v1/slack`. The manifest turns
on the Home tab: reinstall the app after you import this change, or Slack sends no
`app_home_opened`. To post the digest in a channel, invite Sym to it first;
the manifest has no `chat:write.public`.

Allow-list: the pack's owner and `allowList`, or `SYM_SLACK_USERS` without a pack. Approvals
(tool approvals such as schedules, playbooks, and Stop) count only from the owner: the pack owner,
else `SYM_OWNER_SLACK_USER`. Questions, including Start, Edit, and Cancel, stay open to allowed
users. Every inbound
handler checks it and fails closed, including answers to buttons. Free-text answers go through
Eve's "Type your answer" box, so the same check covers them; a reply typed in the thread is a new
message, not an answer (decision 065). Thread context still includes
messages from other people in the thread. The instructions treat that text as data, and job
launches need approval.

## Threads with several people

Decision 050. A reply in a thread with a session no longer starts a turn by default. Code in
`onMessage` (`lib/slack/addressing.ts`) decides, in this order:

1. A message that tags Sym is for Sym.
2. In a thread set to `mention-only`, nothing else starts a turn.
3. A message that tags someone else is for them, so Sym skips it.
4. If the sender is the only human in the thread, Sym replies.
5. The person Sym last served (the user of the thread's latest turn), or any message that says
   Sym's name as a word (`SYM_BOT_NAME`, default `sym`), starts a quiet turn. The brain decides
   whether to reply or call `no_reply`.
6. Anything else is skipped. In a shared thread, other people tag Sym.

A quiet turn shows no status line and no loading messages until the brain calls a tool other than
`no_reply` or writes reply text. A quiet turn does not change who Sym serves.

Each dispatched turn in a shared thread carries a People note: each human as `<@ID>` with a
display name and a role (owner, allowed, or not on the allow-list). Names are cleaned and cached
for an hour. The roles and user IDs decide what a person may do.

Anyone allowed can say "answer only when tagged" and Sym records `mention-only` for that thread
(`thread_listen`, table `thread_listen`). It needs no approval. "Listen again" sets it back.

Thread context: the first turn of a session reads the whole thread. Later turns read only what
came after Sym's last post. Direct messages are unchanged.
