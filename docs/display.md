# The display rule

Rich Slack parts help only when they carry state that changes or a choice to make. Everything else
is text. Sym decides each message's form with one rule in code, not by model taste.

The core fact: an edited message notifies nobody, and a new message notifies. So progress goes
into edits of a card. New messages are only for "you need to act" and "it is done".

## Display levels

| Level | What posts | Notifies |
|---|---|---|
| 0. Silent | Nothing. One line in the evening digest, when it is on (decision 054) | No |
| 1. Text | One plain message. The status line shows work while it runs | Once |
| 2. Text and buttons | One message with fixed choices | Yes |
| 3. Live card | One job card, edited in place, then one result message | At start and end |
| 4. Document | A 2-line summary plus a snippet file | Once |

## The decision, in order

1. Does someone need to act (approve, answer, unblock)? Level 2, in the job thread or the
   approver's DM. Quiet settings never hide this.
2. Is there anything new to say? No: level 0. A clean scheduled check, or a job with no change
   since the last post, stays silent.
3. Will the work run longer than about 2 minutes, with 3 or more steps worth following? Level
   3. Shorter work gets level 1, and the status line covers the wait.
4. Is the answer longer than about 40 lines, or a table with more than 10 rows? Level 4.
   Otherwise level 1.

## Modifiers

Code applies these after the four steps. Quiet mode and DM targets are built; requester hints,
learned preferences, and shared channels are planned.

- The requester's words win. "Quick", "just tell me", or "quietly" force text. "Show me
  progress" forces a card. The model passes these as a `hint`; code still applies step 1.
- Learned preferences per job class. Example: "on-call check: text only", learned from a 👎
  or "too noisy" on an earlier card. These are memory facts, so they apply on the next turn.
- Quiet mode. `/sym quiet` saves `quiet_until` in the ledger `settings` table, and the pack's
  `quietHours` and `timeZone` (UTC when unset) give the quiet hours. A window such as 22:00 to
  07:00 crosses midnight; `from` is inside it and `to` is outside. Only level 2 and failures post.
  The rest waits for the digest, when it is on (decisions 029 and 054).
- Shared channels (team phase). Level 3 only for jobs someone asked for in that channel. Other
  updates go to the requester's DM.
- Upgrade and downgrade during a job. Text work that passes 2 minutes gets a card ("This is
  taking longer. Tracking it here."). When a card job ends, the card collapses to one line and the
  result posts as text.

The job card is now a working note: explicit progress, optional skipped scope, and a muted
time/worker/PR line. It has no controls. Updates are silent edits. The result posts separately.

Results use human sentences in a `markdown` block, with no fixed headings, confidence score,
concern list, or checklist. Code expands inline {{c1}}, {{q1}}, {{tests}}, and {{pr}} tokens to
exact facts, then appends only missing concerns, open decisions, PR and test facts in one paragraph.
Contradictory test prose uses the plain fallback. Only the duration stays in the muted context line.
Job and schedule references stay in tool fields, worker messages, and recovery keys. Messages
name the work with a linked title outside its conversation, or say "this" inside it (decision 073).
Notifications retain the result facts. Results can include PR/CI links, two or three conversation
choices, and optional feedback. Chat replies have no feedback controls. Choices never approve work.

`offer_choices` stores the conversation and consumes a click once. Typed replies still work.
Interactive work and follow-ups always show Start / Not now, including trusted playbooks.
Approved schedules start without a click (decision 024). The trust ladder no longer auto-starts jobs. Stop keeps owner confirmation.
A `posted: true` result suppresses only a duplicate reply to that tool result.

Plain sentences are the default. Lists, tables, quotes, checkboxes, and code fit only content
with that shape. Images become links. Lists stay flat. Slack markdown blocks hold 12,000
characters. Longer completed brain replies use a Markdown file and their first paragraph as the comment through the
outbox. Reactions are rare responses to a person's message, with code-owned limits.

## Implementation

```ts
// lib/display.ts
chooseDisplay({
  kind,         // job class, for example "code-change" or "on-call-check"
  needsAction,  // a person must approve, answer, or unblock
  isNew,        // something changed since the last post
  failed,       // the job failed; failures post even in quiet mode
  estMinutes,   // expected duration
  steps,        // steps worth following
  lines,        // answer length in lines
  tableRows,    // rows in the largest table
  surface,      // "dm" | "channel" | "shared-channel" | "schedule"
  askedHere,    // in a shared channel: the job was requested there
  hint,         // "text" | "card", from the requester's words
  prefs,        // learned preferences, for example { textOnly: true }
  quiet,        // quiet mode or quiet hours
}): { level: 0 | 1 | 2 | 3 | 4; target: "thread" | "dm"; reason: string };
```

- Every post goes through `chooseDisplay`. The outbox refuses a post without a display choice.
- One exception: the App Home view. `views.publish` replaces a page the user opens and sends no
  message or notification, so it skips the outbox and `chooseDisplay` (decision 052). It still
  uses the `SlackApi` seam and logs only Slack's error code on a failure.
- The choice and its reason are logged on the ledger row.
- Unit tests cover each step and modifier. `eve eval` cases pin the end-to-end behavior: a clean
  on-call check posts nothing, a 30-second question gets text, a code job gets a card.

The [mockups](mockups/index.html) show the same job as a card and as text, and the flowchart of
this rule.
