# 006. Only the Slack route is public

Status: accepted
Date: 2026-10-19

## Context

Eve receives Slack through the HTTP Events API, so it needs a public HTTPS endpoint. The MCP channel, HTTP channel, and worker must not face the internet.

## Decision

Expose only `/eve/v1/slack` and `/.well-known/workflow/` publicly, through the host's proxy with a path allow-list. The reference deployment uses Dokploy's public domain. Everything else stays on a private network such as a tailnet.

## Consequences

Adopters must run a proxy that filters paths. Worker callback URLs must resolve from the worker host; milestone 1 checks which host `createWebhook` returns.
