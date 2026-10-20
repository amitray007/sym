# 053. Stranger replies: a private line for people off the allow-list

Status: accepted
Date: 2026-10-20

## Context

Sym dropped every message from a person off the allow-list without a word, and `/sym` answered
"You are not on Sym's allow-list." A person who tagged Sym and got silence could not tell a broken
bot from a closed door, and did not know whom to ask.

## Decision

1. **Triggers.** A human off the allow-list gets one private line when they tag Sym
   (`onAppMention`), write in a direct message (`onDirectMessage`), or write in a thread that has
   a session and tag Sym or name it as a word (`onMessage`, `namesBot` with `SYM_BOT_NAME`).
   Untagged side talk gets nothing. Bots and Sym itself never get a line.
2. **No model.** The message never reaches the brain. The existing drop log line stays (user ID
   only, never the text). No ledger row is written.
3. **Delivery.** `sayPrivately` posts an ephemeral message: in the thread for a thread reply,
   and in the channel for a top-level tag.
   Ephemeral replies are an exception to the outbox and `chooseDisplay` rule, like `/sym` and the
   sign-in prompts: they are private, carry no job, and need no retry.
4. **Cooldown.** One line per user and channel (or direct message conversation) per hour. A
   new thread earns no extra line, so repeated top-level tags cannot spam. It lives in process
   memory with a size cap, like `lib/slack/thread-state.ts`. A restart forgets, which lets one
   more line through.
5. **The line.** `strangerLine` (`lib/slack/strangers.ts`, pure) picks by persona, from the same
   sources as the loading messages (stored setting, `SYM_PERSONA`, pack). A casual or spicy
   persona picks the spicy list with probability 0.7 and the casual list with 0.3, then a uniform
   line. A plain persona or a pack persona (custom text) gets "Sym only works for people on its
   allow-list. Ask {owner} for access." `{owner}` becomes `<@ID>` from `ownerUserId`. With no
   owner, every persona gets "Sym only works for people on its allow-list." A failed persona
   read gives the straight line.
6. **`/sym`.** A stranger who runs `/sym` gets a stranger line in place of the fixed refusal,
   with no cooldown, because they ran a command.
7. **Off switch.** `SYM_STRANGER_REPLIES=off` brings back the silent drop. `/sym` then gets the
   straight line.
8. **Failure.** A failed send or persona read logs one warning without message text and never
   throws out of a hook.

## Consequences

- A stranger learns that Sym exists and who the owner is. The owner tag is already visible in the
  workspace, and the line holds no other detail.
- The jokes cost nothing at run time and need no review beyond this list. A deployment that
  wants none sets a plain persona or the off switch.
- The cooldown lives in one process. Several processes may each send a line.
- Not run against a real Slack workspace. The tests use fakes.
