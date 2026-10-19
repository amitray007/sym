# 018. The brain model goes through the AI Gateway

Status: accepted
Date: 2026-10-19

## Context

Sym's brain model plans, writes briefs, and summarizes. Workers do the heavy work with their own
models. The owner wants to try different brain models without code changes. Eve takes either a
provider-authored model, such as `anthropic()` with `ANTHROPIC_API_KEY`, or a gateway model ID
string routed through the Vercel AI Gateway.

## Decision

`agent/agent.ts` selects a gateway model ID at `session.started`: `SYM_MODEL` when set, otherwise
`anthropic/claude-sonnet-5.5`, with medium reasoning. The deployment sets `AI_GATEWAY_API_KEY`.

## Consequences

Any gateway model works by changing an environment variable and restarting. A session keeps its
model, so the prompt cache stays valid. The gateway adds one service between Sym and the
provider, and model calls are billed through it. Prompts stay model-neutral.
