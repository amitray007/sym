# 094. Prompt-cache lifetime, cache-write pricing, and a cache log

Status: accepted
Date: 2026-11-04

## Context

Eve already caches the brain's prompt. On the direct Anthropic route it marks four cache
breakpoints: the end of the tools, the end of the system prompt, the last assistant message, and
the newest message. On the gateway it sets `gateway.caching: "auto"`. The default cache lives 5
minutes. People in Slack often answer more than 5 minutes apart, so the next turn writes the whole
prompt to the cache again.

The spend estimate for a direct provider (decision 080) counted cache writes as new input. A
cache write costs 1.25x input for the 5-minute cache and 2x for the 1-hour cache. Nothing showed
whether the cache hit.

## Decision

`SYM_PROMPT_CACHE_TTL` sets the cache lifetime: `5m` (default) or `1h`. `1h` applies only with
`SYM_MODEL_PROVIDER=anthropic`, through Eve's `modelOptions.promptCache`. Eve rejects that option
on the gateway, which manages its own caching, so on other routes the setting warns once and does
nothing. An unknown value warns and uses `5m`.

`lib/brain/budget.ts` prices cache writes at 1.25x or 2x the reference input rate, by the
lifetime. New input is input minus cache reads and cache writes.

The `agent/hooks/cache-usage.ts` hook logs one `model cache usage` line for each model run and
compaction summary: input, cache reads, cache writes, uncached input, and the hit rate. It skips a
delegated call's record, because the subagent's own runs already logged it.

## Consequences

An owner on the direct Anthropic route can trade a dearer first write for cheaper later turns.
The 1-hour cache pays off when follow-ups land between 5 and 60 minutes apart; the log shows
whether it does. Not every Claude model accepts a 1-hour cache. The spend limit on a direct route
stops a little earlier than before, because cache writes now cost more than plain input.
