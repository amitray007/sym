# 027. Worker threads call Sym through the MCP channel, and tools check the caller

Status: accepted
Date: 2026-10-20

## Context

Worker threads should report progress and ask the owner without waiting for Sym's next poll
(docs/eve.md). Eve's MCP channel publishes tools with `tools: true`, which is a yes or no: every
plain tool goes out, not a chosen set. Workflow tools such as `t3_job` never go out, and tools
with an approval return `approval_required`.

## Decision

`agent/channels/mcp.ts` accepts `Authorization: Bearer <SYM_MCP_TOKEN>`, compares it in constant
time, accepts nothing when the variable is unset, and gives the caller the principal
`sym-worker`. It publishes no agent tools. Worker-facing tools (`sym_post_progress`,
`sym_ask_owner`) are deferred, so the brain does not list them, and they answer only the
`sym-worker` principal. Tools that change Sym's state, such as the schedule tools, refuse that
principal (`lib/callers.ts`). Worker text is capped and escaped before Slack sees it.

## Consequences

A holder of `SYM_MCP_TOKEN` can still read job and schedule status, so the endpoint stays on the
private network. A new plain tool that changes state must add the caller check.
