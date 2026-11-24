# 103. Findings from an investigation stay short

Status: accepted
Date: 2026-11-24

## Context

Decision 093 caps most replies at one to three short lines and lets a reply run longer when
"the answer is a real list". Investigation findings, such as a reply to an alert, use that
exception. The brain writes a verdict, then bullets that each hold a paragraph and every number
it found. The reply passes as a list but reads as a wall of text.

## Decision

- Findings from an investigation, an alert, or a run follow the six-line limit. The shape is a
  one-line verdict, at most three one-line bullets, and a one-line next step.
- Each bullet carries one fact and at most two numbers. The brain picks the numbers that prove
  the verdict and leaves the rest out. The person asks for more.
- A guess stays labeled and a concern stays visible, as in decision 093.
- Each persona's example table gains an "Investigation findings" row. Examples steer the model
  more than rules do.
- The researcher subagent returns the verdict first and only the numbers that prove it.

## Consequences

- Detail the brain collected but did not post is lost unless the person asks. A follow-up
  question reruns the lookup or reads the thread.
- No new eval gate. `isQuickReply` already fails a reply over 600 characters or six lines; the
  owner runs `pnpm eval` to check the change against the real model.
