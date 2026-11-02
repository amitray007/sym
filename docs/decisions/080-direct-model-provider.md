# 080. The brain model can call Anthropic or OpenAI directly

Status: accepted
Date: 2026-11-02

## Context

Decision 018 routes the brain model through the Vercel AI Gateway. Some owners already hold an
Anthropic or OpenAI API key and do not want a Vercel account between Sym and the provider. Eve
ships `anthropic()` and `openai()` helpers that call the provider directly with
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

## Decision

`SYM_MODEL_PROVIDER` selects the route for the brain and its subagents: `gateway` (default),
`anthropic`, or `openai`. With a direct provider, `lib/brain/model.ts` returns the Eve helper's
model, and `SYM_MODEL` takes the provider's native model ID, such as `claude-sonnet-5-5`. An unset
`SYM_MODEL` uses the helper's default model. An unknown provider warns once and uses the gateway.
`SYM_REASONING` applies to every route.

## Consequences

An owner needs one provider key and no gateway account. A direct route has no gateway fallback
across providers and no gateway session logs. Eve reads the model's context window from the
gateway catalog, so a direct model that the catalog does not list fails at selection. The
gateway stays the default, so existing deployments do not change.
