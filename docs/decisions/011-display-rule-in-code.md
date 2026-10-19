# 011. The display rule lives in code

Status: accepted
Date: 2026-10-19

## Context

Rich Slack UI helps when state changes or a choice is needed, and becomes noise otherwise. A model choosing the form per message is inconsistent.

## Decision

`lib/display.ts` `chooseDisplay()` picks one of five levels (silent, text, text and buttons, live card, summary and file) by a fixed four-step rule plus modifiers. Every post goes through it, and the choice is logged.

## Consequences

Behavior is testable with unit tests and evals. The model can pass a hint, but code makes the decision. See `docs/display.md`.
