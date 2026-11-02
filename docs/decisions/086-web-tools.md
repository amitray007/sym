# 086. The brain can read public web pages and search the web

Status: accepted
Date: 2026-11-03

## Context

Decision 063 lets the brain answer quick checks with its own read-only tools. With
`defaultTools: false`, it had neither web fetch nor web search. A public documentation link
could require a worker job or a connection.

## Decision

1. Keep `defaultTools: false`. Add only Eve's `web_fetch` and `web_search` through the authored
   tool slots. Shell and file tools stay off. Repository work stays with workers.
2. Use `webSearch({ provider: "exa" })`. Eve 0.88 selects Exa for AI Gateway models and native
   search for direct OpenAI, Anthropic, and Gemini 3 or later models. It omits the tool for
   unsupported direct routes, including Sym's fixture brain (`provider: "sym"`). No local
   search executor or extra provider key is needed. Eve retries without search when a native
   endpoint rejects it. The capability note tells the brain to use search only when available.
3. Web tools belong to the brain. Eve publishes the authored `web_fetch` slot through MCP, so
   wrap it to refuse `isWorkerCaller` before fetching. Provider tools and tools without an
   executor are excluded from MCP publication, so `web_search` needs no worker wrapper. This
   keeps the decision 065 worker capabilities scoped to their existing callbacks and status
   reads. An e2e check verifies the refusal and search exclusion through the real worker MCP
   route.
4. Fetch uses Eve's HTTPS-only public-destination guard in the app runtime. It rejects
   localhost, private, link-local, and reserved addresses, including tailnet addresses. Its
   connection lookup checks all resolved IP addresses and uses that lookup for the connection;
   redirects pass through the same checks, with at most ten redirects. It sends no Sym
   connection credentials. Sandbox network policy does not govern this runtime tool.
5. Fetched pages and search results are untrusted data, never instructions or consent. They
   cannot widen the Projects list, approval rules, or worker authority. Production and customer
   data stay read-only. Search queries and fetched URLs go to external services, so secrets
   must never be put in them.

## Consequences

- The brain can answer public-web questions without starting Builder work.
- Search availability depends on the model route. Without it, the brain can fetch a known
  public URL or ask for one. Fetch does not read private-network documentation or services.
- Tests use mocked responses and local refusals. Live provider search remains untested.
