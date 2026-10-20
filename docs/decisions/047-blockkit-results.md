# 047. Result and failure posts are Block Kit, and the feedback buttons have an off switch

Status: accepted
Date: 2026-10-20

## Context

Decision 044 made the result message short and structured, but it was one mrkdwn string. Slack
renders a long string as a wall, with no visual weight on the title, the verdict, or the PR link.
Slack also offers `header`, `rich_text` lists, `context`, and link buttons that fit the result.

## Decision

1. **The result and the failure are Block Kit.** `lib/jobs/blocks.ts` builds them from the same
   facts as the mrkdwn text (`resultView` in `lib/jobs/messages.ts`), so the two forms cannot
   drift. The mrkdwn text stays in the post as the `text` fallback, which Slack uses for
   notifications and screen readers.
   - Result: `header` (emoji, `J-n · title`, duration), `section` with the tl;dr, `section` with
     the verifier line, `section` + `rich_text` (ordered list) for the concerns, `section` with the
     `☐` open questions, a `context` footer (tests, file count), and an `actions` block with an
     **Open PR** link button when there is a PR. No dividers: the blocks are already compact.
   - Failure: `header`, `section` with the reason, `context` with the worker thread.
   - The cancelled notice, the start line, the permission DM, and the quiet notice stay text.
2. **Limits are enforced in the builder.** Headers stop at 150 characters (the title is cut, the
   duration stays), sections at 3000, lists at 10 items (`…and N more`), and a message at 50
   blocks. A cut ends with `…`. Sections escape worker text for mrkdwn (`&`, `<`, `>`) and keep the
   escaped text inside the limit. Rich text takes the text as typed, so it needs no escape.
3. **The outbox carries `blocks` in the payload.** `chat.postMessage` and `chat.update` already
   pass the payload to Slack unchanged. `chooseDisplay` still decides every post. The PR button
   reuses the card's `sym_job_pr` action id and its http(s) URL check.
4. **Concern text is casual and lowercase** (decision 044's voice): `worker opened a PR the job
   didn't allow.` The verifier's instructions ask for the same style. Meaning is unchanged.
5. **`SYM_FEEDBACK=off` removes the feedback buttons.** `on` is the default. `off`, `false`, `0`,
   and `no` (any case) turn them off; anything else, including unset, leaves them on. The feedback
   handlers stay, so clicks on old messages still record. The Open PR button is not affected.

## Consequences

`rich_text` in `chat.postMessage` is accepted by Slack, but the fake Slack server in tests does not
validate block schemas. The live run with the test Slack app checks the real rendering. The feedback
buttons sit on the brain's final replies (`agent/channels/slack.ts`), not on the result post, so
the switch changes replies only. `/sym status` and `jobs_status` text are unchanged.
