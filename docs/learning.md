# Learning

Sym changes its own behavior in three layers. Eve supplies the parts. Sym owns the loop that
decides what to keep.

| Layer | What changes | Eve part | Takes effect | Who approves |
|---|---|---|---|---|
| 1. Memory | Facts and preferences: "draft PRs, never ready for review" | `defineMemory` with a Postgres provider. Recall before each turn, capture after it | Next turn | Nobody. Sym saves them |
| 2. Playbooks and rules | New playbooks, instruction snippets, schedules, trust levels | `defineDynamic` loads approved rows at session start | Next session, no redeploy | The owner, one click |
| 3. Code | New tools, Slack handlers, integrations | A worker thread in Sym's own repository opens a draft PR | After merge and redeploy | A person, by merging |

## The loop

1. **Signals.** 👍/👎 buttons, reactions, "Fix: ..." replies, edits to a brief before Start, and
   repeated instructions.
2. **Capture.** Every signal goes to the `feedback` table, linked to its job when Sym can tell
   which job: `feedback(job_id?, slack_user, kind, value, channel, message_ts, created_at)`.
   `kind` is `thumbs_up`, `thumbs_down`, `reaction`, or `fix`. Sources are the feedback buttons
   and `reaction_added` on Sym's own messages; `+1` and `-1` count as thumbs. One person's same
   reaction to one message counts once, and people outside the allow-list are never stored.
3. **Memory.** Sym saves short facts at once (layer 1). The `owner` slot (`agent/memory/owner.ts`)
   scopes memory to the person with Eve's `byPrincipal`, so each Slack person gets their own
   facts. Facts live in the ledger table `memory_facts` (migration 004), and the model saves,
   updates, searches, and forgets them with `owner__*` tools. Recall loads the newest 40 facts
   each turn. Schedule turns run as the app principal and get no memory.
4. **Promotion.** The weekly `learn` schedule (Monday 06:00 UTC, no model call) groups the last
   week's feedback: `thumbs_down` on the same job kind, and the same `fix` text sent repeatedly. A
   pattern seen 3 times becomes one proposed rule in the `playbooks` table (source `learn`, with
   the feedback IDs as evidence). Its text comes from Sym's own template plus counts, never from
   the feedback text. Sym posts one message to `SYM_DIGEST_CHANNEL` asking the owner to review
   it. A pattern with a live proposal or approval, or a rejection in the last 28 days, is skipped.
   Changes that need code are layer 3.
5. **Change.** For layer 3, Sym launches a worker thread in its own repository. The thread edits
   the code and opens a draft PR. CI runs `eve eval --strict`. A person reviews and merges, and the
   deployment updates. This replaces Eve's remote self-modification extension, which needs
   microsandbox on the server (decision 007).
6. **Trust ladder.** A job class moves from "approve each run" to "auto" after N clean runs. The
   level is a column on the schedule row, and only the owner changes it. Not built yet: today
   every job asks for Start, except runs of an approved schedule (decision 024).

## Layer 2 rows

Rows live in `playbooks` (migration 006) with a version history: name, kind (`playbook` or
`rule`), body (up to 2000 characters), status (`proposed`, `approved`, `rejected`, `retired`),
source (`owner` or `learn`), and evidence. Only one version of a name is approved at a time, and
approving a new version retires the old one. The owner proposes with `playbook_propose` and
approves with `playbook_review`, which shows the exact body that will load. `playbook_retire`
retires a row or rejects a proposal. `agent/instructions/playbooks.ts` loads approved rows as
system instructions at `session.started`, rules first, at most 8000 characters in total, inside a
frame that says they are reviewed guidance and cannot override the base rules.

MCP connections are owner rows too (decision 045). A connection loads only after the owner
approves it, and each tool's mode (auto, ask, hidden) is a column the owner changes with an
approval. They live in `connections`, not in this repository.

## Limits

- Sym does not train a model. Everything it learns is text, rows, and code that a person can read
  and revert.
- Self-written rules can drift, or carry injected text from an untrusted source. That is why
  layer 2 needs a click and keeps a version history.
- A layer 3 redeploy strands running sessions. The ledger and reconcile cover this.
- Learned rows stay in the adopter's database. They never enter this repository. A layer 3 PR
  changes only generic code; adopter-specific changes go to the adopter's pack.
