# 103. Every reply is written for a glance, and a code check enforces it

Status: accepted
Date: 2026-11-24

## Context

Decision 093 caps most replies at one to three short lines, but lets a reply run longer when
"the answer is a real list". Replies with a lot to report use that exception. The brain writes
a verdict, then bullets that each hold a paragraph and every number it found. The reply passes
as a list but reads as a wall of text, and people skip it.

A rule for one kind of reply only moves the problem to the next kind. Prompt rules alone also
drift as models change.

## Decision

- The Voice rules gain one general rule: write for a glance. The answer goes first, each idea
  gets its own short line, and only details that change what the reader thinks or does stay. A
  list does not lift the length limit.
- Each persona's example table gains an "A lot to report" row. Examples steer the model more
  than rules do. The spicy persona drops its "Question" row to stay under its 40-line limit.
- `lib/voice/readable.ts` measures a reply's prose, outside code blocks, tables, and quotes. It
  flags a line over 160 characters (about two Slack rows), a line with more than four numbers,
  or more than 800 characters of prose.
- `queueReply` runs every chat and run reply through a rewrite pass (`lib/voice/tighten.ts`). A
  readable reply skips it. A flagged reply goes once to a small model with the same rules. The
  rewrite posts only when it adds no number, keeps every link, and passes the check. A missing
  route, an error, an 8-second timeout, or a failed check posts the original.
- `SYM_READABLE=off` turns the pass off, and any other value names the model. The default is
  `anthropic/claude-haiku-5.5` on the gateway and `claude-haiku-5-5` on the direct Anthropic
  route. The direct OpenAI route and the fixture brain have no pass. Unit tests set it off.
- `slack_post` and job results keep their own paths. A `slack_post` text is approved as written,
  so a rewrite after approval would post words the person did not see. Job results carry
  code-owned fact tokens; the writer gets the one-idea-per-line rule instead.
- The researcher returns the verdict first and only the numbers that prove it.
- A new eval (`evals/voice/readable.eval.ts`) gives the brain a dense metrics dump and checks
  the reply with the same `isReadable` floor and a judge grading "readable at a glance".

## Consequences

- A flagged reply costs one small-model call and up to 8 seconds. Readable replies cost nothing.
- The rewrite may drop supporting detail. The person asks for it if they want it.
- The fact guard checks numbers and links, not meaning. A dropped warning is caught only by the
  rewrite rules and the evals.
- Each rewrite and each kept original logs the problems it found, so the thresholds and rules
  can be tuned from real traffic.
