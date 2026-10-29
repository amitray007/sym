# Slack

Slack has native parts for agent apps: a thread status line, task and plan blocks, feedback
buttons, and an agent surface. Eve drives some of them. Sym's own code drives the rest through
`ctx.slack.request` and `callSlackApi`. [display.md](display.md) decides which part each message
uses.

## The working note

Each long job gets one working note. Sym edits it silently with explicit worker progress and
optional scope it is leaving alone. A muted line holds the job reference, elapsed time, worker,
and PR link. It has no controls or invented checklist. The ledger stores the desired message and
its Slack timestamp. Reconcile can keep it current after a session dies.

When the job ends, the note collapses to one line. The result posts separately. A PR opening
updates the note without a new post. After 20 quiet minutes the note says Sym is still checking.
After 45 minutes Sym asks once whether to stop.

## Surfaces

| Surface | What Sym shows | Driven by | When |
|---|---|---|---|
| Thread status line | "Launching worker thread", "Tests running" | Eve: `label.start`, `label.delta`, task `yield` | Milestone 1 |
| Working note (`section` and `context`) | Working note with explicit progress and no controls | Sym: `chat.update` | Built |
| Eve task card | Short tasks that are not worker jobs | Eve | Milestone 1 |
| Buttons and selects | Approve a brief, answer worker questions, approve rules | Eve: approvals, `ctx.ask` | Milestone 1 |
| "Type your answer" modal | Free-text answers | Eve, inside `ctx.ask` | Milestone 1 |
| Feedback buttons | 👍/👎 on job results only | Sym: renderer posts the reply with a `context_actions` block | Built |
| Reactions | A rare emoji on a person's message: 😂 funny, 💡 good idea, 🙌 good news, 🫡 ack. Never 👀, never on every message (decision 051) | Brain: `slack_react` and `slack_emoji`, limits in code | Built |
| Ephemeral replies | `/sym status`, private sign-in prompts, stranger lines | Eve, Sym | Production |
| Long output | Long completed replies as a Markdown file | Eve | Production |
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
## Voice

Sym uses short sentences in one configured persona (decisions 070 and 071). It gives the point
first and preserves facts, links, warnings, scope boundaries, and uncertainty. Plain is calm,
casual is warm and practical, and spicy is dry and playful. Failures and concerns never get jokes.
The persona comes from the pack, then the saved owner setting, then `SYM_PERSONA`, then casual.
The initial status fallback is "Working...". Tool labels replace it with known steps.

The writer returns human text with inline fact tokens such as {{c1}}, {{q1}}, {{tests}}, and {{pr}},
and optional choices. Code expands each token to its exact concern, decision, or fact. Missing
facts appear together as sentences; facts already in the body do not repeat. Contradictory test
claims use the plain fallback. PR and test facts stay code-owned in the notification text. Tests distinguish passed, failed, not run, unknown, and no applicable tests.
The result has no fixed headings, confidence score, numbered concern list, or checklist.
A writer failure or a recovered job uses the plain deterministic result.

Text uses Slack's `markdown` block. Lists, tables, code, quotes, and checkboxes fit only content
that needs them. Images become links and lists stay flat. A markdown block holds 12,000
characters. Completed brain replies over that limit become a Markdown file with its first paragraph as the comment.
Replies pass through `chooseDisplay` and the outbox, which retries delivery and checks deleted roots.
Ordinary chat replies have no feedback buttons.

## Conversation and consent

Sym checks read-only facts with its own tools first. A problem report does not authorize Builder.
`worker_job` requires an explicit request for Builder work or acceptance of a specific offer,
including for repository investigations. The brief still needs its code-owned Start approval.
Interactive chat always shows Start / Not now, even for trusted playbooks. Approved schedules
start without a click (decision 024). The trust ladder no longer auto-starts jobs.

- A question about a result stays chat.
- A requested redirect of running work uses `job_steer`.
- A requested change to finished work uses `job_followup` with `{ ref, change }`. It proposes
  Start / Not now before sending work. Start checks current policy and worker identity.
- An explicit stop uses `job_stop` with owner confirmation.
- "We're done" on finished work uses `job_close` with `{ ref }`.
- Side talk and bare acknowledgements use `no_reply`.
- `offer_choices` takes `{ message, choices }` for two or three real alternatives. Labels have
  at most 30 characters. A click checks the allow-list and stored conversation, consumes the
  choice once, and starts a normal turn as the actor. Typed replies still work. Choices grant
  no tool or approval authority.

A tool result with `posted: true` suppresses its duplicate reply only. Later questions still get
answers. Saved preferences never grant consent for Builder work.

## People off the allow-list

Sym never sends a stranger's message to the brain. A tag, DM, or named reply in a known thread
gets one private access line pointing to the owner. Untagged side talk stays silent. The limit
is one line per person and channel per hour. Failed private delivery releases that cooldown.
The persona can vary the wording without ridicule. With no owner, the line points to the person
who runs Sym. `SYM_STRANGER_REPLIES=off` disables these replies.

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
- The brief names the title, project, delivery, model, and playbook. Start / Not now binds to
  that proposal. Revising the brief expires it. Legacy Full brief buttons still show the stored
  goal, constraints, and done-when list privately.
- Working notes have no action controls. Results have PR and CI links when known, optional
  conversation choices, and native feedback when enabled. Feedback buttons appear only on
  results. Reactions on Sym's messages still record feedback. `SYM_FEEDBACK=off` hides buttons
  while handlers keep accepting old clicks.
- Legacy controls remain routable. A legacy change submission creates a follow-up proposal
  with Start / Not now; submitting text never starts work.
- Home shows Needs you, Running, and Finished today with job links. Start waits, schedules
  waiting for approval, and incomplete closures go under Needs you and change the opening summary.
  Finished today labels failed and cancelled jobs as such. The owner also sees Setup,
  including worker state, persona, quiet mode, projects, and connections. It renders no Retry
  or Stop controls. Every Home open rechecks the allow-list and owner role.
- Permission notices go to the recorded owner, else the pack owner, else `SYM_OWNER_SLACK_USER`.
  With no owner, the job thread asks for one to be configured.

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
| `code_channels:manage` | Create, archive, and label a job's code channel (decision 067) |
| `channels:read`, `groups:read`, `mpim:read` | Tell a code channel apart (`conversations.info`) |

Events: `app_mention`, `message.im`, `message.channels`, `message.groups`, `reaction_added`, `app_home_opened`,
`agent_session_stopped`. The manifest also turns on `features.code_channels`.
Interactivity and the slash command use the same request URL, `/eve/v1/slack`. The manifest turns
on the Home tab: reinstall the app after you import this change, or Slack sends no
`app_home_opened`. To post the digest in a channel, invite Sym to it first;
the manifest has no `chat:write.public`.

Allow-list: the pack's owner and `allowList`, or `SYM_SLACK_USERS` without a pack. Approvals
(tool approvals such as schedules, playbooks, and Stop) count only from the owner: the pack owner,
else `SYM_OWNER_SLACK_USER`. Start / Not now proposals and worker questions stay open to allowed
users. Every inbound
handler checks it and fails closed, including answers to buttons. Free-text answers go through
Eve's "Type your answer" box, so the same check covers them; a reply typed in the thread is a new
message, not an answer (decision 066). Thread context still includes
messages from other people in the thread. The instructions treat that text as data, and job
launches need approval.

## Code channels

With `SYM_CODE_CHANNELS` on, a job a person starts moves from its thread into its own Slack code
channel (decision 067, [slack-code.md](slack-code.md)). The brief and Start stay in the thread;
Slack links the new channel there. The card, result, and buttons post top-level in the channel.
Worker questions post in the current job conversation, including code channels. The channel's context bar shows the job, its project, and its pull request, and its status
follows the job. Everything said in the channel reaches Sym with no tag and is about that job.
`job_close` requests settlement and archive, with the result shared in the original thread. A scheduled check, a job
in a DM, and any job Slack refuses stay in their thread.

A person can also ask Sym to move a conversation into a code channel. The brain's `code_channel`
tool opens one through Eve, copies the conversation, and continues there (decision 068). A job
started inside a code channel uses that channel instead of opening another.

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

Follow-up Start rechecks current project permissions, pack limits, and worker identity. A changed
project or unknown worker identity needs a new job. Typed Fix does not bypass proposal approval.

Close acceptance, worker settlement, and archive confirmation are separate ledger facts.
Reconcile retries incomplete closure. Slack's already-archived response confirms closure.
A refusal leaves an archive retry control. Sym reports success only after confirmation and
removes stale retry notices. Missing clients or channel IDs remain visible repair states.
