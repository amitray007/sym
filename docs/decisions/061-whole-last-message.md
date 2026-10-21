# 061. The job check reads the worker's last message whole

Status: accepted
Date: 2026-10-21

## Context

Sym reads worker activity with `t3_thread_read` and `maxCharsPerItem: 4000`, so a long tool
output does not fill the job card. The worker ends its last message with the result block
(the output contract), after its report. A report over about 4,000 characters pushed the block
past the cut. The parser found no closed block, and the result said the worker sent no summary,
although the worker had sent one.

## Decision

1. `readActivity` marks a cut item with its item ID and the offset where its text goes on.
2. The worker adapter has an optional `readRest`. On T3 it calls `t3_thread_read` with
   `view: activity`, `itemId`, and `textOffset`, in 50,000-character pieces, at most 20 of them.
   It stops when T3 has no more text or a piece does not move the offset on.
3. Only `checkJob` calls it, and only for the newest assistant message it stores as the last
   message. Other readers, such as PR follow, keep the cut text and make no extra calls.
4. The stored last message keeps its last 20,000 characters, with a leading ellipsis when it is
   cut. The result block is at the end, so it survives the cut.
5. A failed `readRest` keeps the cut text and logs a warning. The job still ends; its result then
   says the worker sent no summary, as before.

## Consequences

- A long report no longer hides the result block.
- The last message passes through workflow steps, so it is held to 20,000 characters, not the
  whole report.
- A worker without `readRest` behaves as before.
