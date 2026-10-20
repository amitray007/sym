# 046. The owner switches the persona from Slack, and the status line follows it

Status: accepted
Date: 2026-10-20

## Context

Decision 044 set the persona with `SYM_PERSONA`, so a change meant editing the environment and
redeploying. The owner wants to switch it from Slack. Eve also shows one fixed status line
("Thinking...") while the brain works. It could carry the persona's voice.

## Decision

1. **A stored setting.** The persona lives in the existing `settings` table under the key
   `persona` (migration 005 added it for quiet mode). Migration 012 adds an `updated_by`
   column to record who changed it. No new table.
2. **Resolution order**, highest first: the pack's persona file, the Slack setting, `SYM_PERSONA`,
   then `casual`. `SYM_PERSONA` is now the default. The dynamic instruction reads the setting at
   `session.started`. A database error warns once and falls back to the environment and default.
   A stored value that is not a built-in name is ignored.
3. **`/sym persona`** shows the current persona, where it comes from, and the choices. Anyone on
   the allow-list can read it. `/sym persona <plain|casual|spicy>` sets it and is owner only
   (`mayDecideAsOwner`, as other owner decisions). Others get a private "Only the owner can change
   this." When the pack sets a persona, Sym says the pack decides and stores nothing. Replies are
   private and neutral, not in the new tone.
4. **`sym_persona` tool.** The owner can say "be spicy" or "tone it down" in plain words. The
   tool takes one of the three names and runs the same code as the slash command, so the owner
   check lives in code and uses the session principal. It needs no approval. Worker callers are
   refused. The new persona applies from the next session, because the instruction loads at
   session start, and the brain says so.
5. **Loading messages.** Eve's Slack renderer `received` hook and the `turn.started` event set
   the status through `assistant.threads.setStatus`. Eve passes only one text, so it sends
   `loading_messages: [text]`. Sym's renderer calls the same method itself, after Eve's default,
   with a list per persona (`LOADING_MESSAGES` in `lib/persona.ts`): `plain` has one line,
   `casual` four, `spicy` four, each under 50 characters and generic. Slack rotates them. A pack
   persona is custom text, so it gets the neutral `plain` list. Later status updates from Eve
   (tool labels, reasoning) replace the list with one text, as before. A failure here only warns.

## Consequences

The persona instruction does one small database read per Slack session. A `received` status call
costs one extra Slack request per message, and one per turn start. The status list lives in code,
not in the persona files, so a pack that wants its own lines has none yet. A stored persona
survives a redeploy, and removing a pack persona file lets the stored setting apply again.
