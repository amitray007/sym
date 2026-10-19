# 023. Local end-to-end runs use fakes and a fixture brain

Status: accepted
Date: 2026-10-20

## Context

Tests must never call a real worker, the real Slack API, or a paid model. Unit tests with fakes
do not prove that Eve, the Slack route, the workflow task, and the ledger work together.

## Decision

`SYM_MODEL=fixture` makes the brain a scripted `mockModel` from `eve/evals` (`lib/brain/fixture.ts`).
`test/fakes/t3-server.ts` is a fake T3 MCP server built on the official MCP server SDK, and
`test/fakes/slack-server.ts` is a fake Slack Web API. The Slack channel takes
`SLACK_API_BASE_URL`. `pnpm test:e2e` runs a real `eve dev` server against them with signed
Slack events and the local Postgres, and checks the milestone 1 exit criteria.

## Consequences

The whole flow runs on one machine in minutes, with no secrets. The fixture brain is a test
fixture in the agent bundle; it is active only when `SYM_MODEL=fixture`. The fakes follow the
real APIs only as far as their authors read them, so a live run still checks the real services.
