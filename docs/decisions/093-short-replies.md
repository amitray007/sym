# 093. Replies stay short, mirror the person, and drop stock assistant phrases

Status: accepted
Date: 2026-11-04

## Context

Decision 062 dropped the fixed result shape and let the brain "pick the length the content
needs". With no default budget, replies drift long in every persona. They restate the question,
recap each step, and close with an offer to help. That reads like a bot, not a teammate.

Texting agents with a well-liked voice, such as Poke, get it from a few strict rules: match the
user's length and style, ban stock phrases, add nothing before or after the answer, keep warmth
for when it is earned, and let a conversation end without a closing line.

## Decision

- The shared Voice rules set a default: most replies are one to three short lines. Longer
  replies need a reason: the person asked for detail, the answer is a real list, or it carries a
  plan or code. Past about six lines, the brain gives the point and stops, or uses a file.
- The brain matches the person's length and mirrors their style inside the persona's limits:
  lowercase if they write lowercase, and emoji or slang only after they use them.
- No preamble or postamble. The brain never echoes the request, recaps, or asks whether the
  person wants more. The Voice rules list banned stock phrases, such as "let me know if you need
  anything else" and "happy to help".
- Warmth comes when the moment earns it. No praise for ordinary requests.
- Jokes stay original and about the work, never two in a row unless the person jokes back.
- A follow-up question gets only its answer. Facts and concerns already in the thread are not
  repeated unless they bear on the question. A fact, reason, or offer is never repeated, and an
  offer is made once.
- When a conversation winds down, the brain reacts or calls `no_reply`.
- Each persona's example table gains a follow-up row and a small-talk row; `plain` also gains a
  "why, with a gap" row. Examples steer the model more than rules do.
- The `writer` subagent aims for three to five short lines per job result.
- `spicy` texts like a gen-z engineer: lowercase and clipped. It matches slang only after the
  person uses it, at most one slang word per message, and never in a warning or concern
  sentence. Its hard limits from decision 044 stay unchanged.
- Evals: `isQuickReply` fails a reply over 600 characters or 6 non-empty lines. The persona
  cases fail on a stock assistant phrase. New tone cases (`evals/voice/tone.ts`) run under each
  persona: a greeting, small talk, a lowercase question, a formal question, a winding-down
  "cool, thanks", and a three-turn chat. Each has fixed checks (length, stock phrases, slang,
  emoji, help offers, the open concern) and a judge model grading whether the reply sounds
  human, fits the message's length, and adds no padding. The three-turn chat's whole-transcript
  grade is a soft score, because it varies too much between runs to gate. This is the first use of a judge
  (decision 039 had none); tone has no deterministic test. With `SYM_MODEL_PROVIDER=anthropic`
  the judge uses `ANTHROPIC_API_KEY` through `@ai-sdk/anthropic` (a dev dependency), so a run
  needs no gateway; `SYM_EVAL_JUDGE_MODEL` overrides its model.

## Consequences

- Facts, links, test outcomes, and concerns stay exact. A short reply still carries every concern.
- Code-built messages, such as job cards and working notes, stay neutral (decision 044). Making
  them sound less like a system is a separate decision.
- Splitting a long reply into several short Slack messages would change the outbox. It is not
  part of this decision.
- The owner runs `pnpm eval`, `pnpm eval:plain`, and `pnpm eval:spicy` to check the new floors
  against the real model.
