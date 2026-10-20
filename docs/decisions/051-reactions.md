# 051. Sym reacts with emoji, rarely, and code holds the limits

Status: accepted
Date: 2026-10-20

## Context

A person often answers a thanks or a joke with an emoji, not a sentence. Sym could only reply in
text, so a short "thanks" got a full message or silence. The owner wants quick, human reactions:
a 😂 for something funny, a 💡 for a good idea, a 🙌 for good news, a 🫡 for "on it". Not the 👀
"seen" kind, and not on every message.

## Decision

1. **Two tools, no approval.** `slack_react` takes `{ emoji }` and reacts on the message that
   started the turn. `slack_emoji` takes `{ keyword }` and returns at most 20 custom emoji names
   that contain it. Both refuse worker callers, because Eve's MCP channel publishes every plain tool.
2. **The brain decides.** `agent/instructions.md` has a short "Reactions" section: react only on
   a clear trigger, most messages get none, a reaction replaces a text reply only for a short
   thanks or ack (then `no_reply`), never a laughing emoji on a failure, incident, or mistake,
   never 👀. Each persona adds one line: `plain` reacts rarely and only with ✅ 👍 🙏, `casual`
   occasionally, `spicy` a bit more and more playfully, under the same limits.
3. **Code holds the limits.** The prompt is not the guard.
   - One reaction per inbound message, and three per thread per hour. The `reactions` table
     (migration `015_reactions`) holds one row per reaction. Its key `(channel_id, message_ts)`
     is the per-message cap, and an index serves the per-thread count. It lives in the ledger,
     not in memory, because a session can span processes.
   - The tool claims the row first, then calls `reactions.add`. A Slack refusal other than
     `already_reacted` deletes the claim. `already_reacted` counts as done.
   - 👀 and `eyes` are refused in code.
   - Reactions go only on a person's message, never on Sym's own posts. Sign-in links, approval
     prompts, and job cards are Sym posts, so they cannot get one.
   - Only Slack error codes are logged.
4. **Which message.** Eve keeps the triggering message in the channel's session state
   (`triggeringMessageTs`), which tools cannot read. The Slack renderer copies it to
   `session_threads.message_ts` at `turn.started`, next to the thread (migration `015`). The tool
   reads it by session id. A session with no Slack row, or no message, gets a refusal.
5. **Names.** The tool accepts `tada`, `:tada:`, or a common unicode emoji (about 30 map to
   Slack names; any other unicode emoji is rejected with a hint to use a name). Slack checks
   standard names itself: `invalid_name` becomes a clear error, so Sym bundles no full list.
   Custom emoji and their aliases come from `emoji.list` (scope `emoji:read`), cached in memory
   for an hour. A failed list is cached for a minute. `slack_emoji` explains a missing scope.
6. **Not a post.** A reaction is not a Slack post, so `chooseDisplay` (decision 011) does not
   apply. It adds no message and no notification.

## Consequences

- The owner must add the `emoji:read` scope and reinstall the app (the manifest has it).
  Without it, standard emoji still work and `slack_emoji` says why it finds nothing.
- Sym's own reaction fires `reaction_added` with the bot as the user. The handler records only
  allowed people, and the bot is not on the allow-list, so it does not become feedback.
- The cap table grows by at most three rows per thread per hour. No cleanup runs yet.
- Whether the brain picks good moments depends on the model. The e2e uses a fixture trigger
  phrase, not a judgment. Not run against the real Slack API.
