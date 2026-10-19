# 036. The owner signs Sym in to the worker from Slack

Status: accepted
Date: 2026-10-20

## Context

Sym needs a bearer token for the worker's MCP endpoint (decision 015). Until now the owner ran
`pnpm t3:login` on a machine with a browser and copied `T3_TOKEN` into the deployment. A T3
sign-in lasts 30 days and has no refresh token, so the owner repeats this every month. A
deployed Sym also had no way to tell "no worker configured" from "worker down", so a missing
token marked every orphaned job `worker_offline`.

T3 facts that shape the flow: the issuer and endpoints derive from the request origin;
registration is stateless; a redirect URI must be https unless it is loopback, and an https URI
must match exactly; `resource` must equal the MCP URL; a code lives 60 seconds; the owner picks
the access level on T3's consent page (decision 009).

Eve 0.81 serves workflow webhooks at `/.well-known/workflow/v1/webhook/:token` for GET, POST,
PUT, PATCH, and DELETE. A browser redirect (a GET with `code`, `state`, and `iss` in the query)
resumes the webhook, and the workflow reads the query from the request URL. `createWebhook`
takes a static `respondWith` response for the browser.

## Decision

- The `worker_sign_in` workflow tool runs the sign-in. Only the owner can use it: the pack
  owner, else `SYM_OWNER_SLACK_USER`. It refuses worker threads, schedules, and other people.
- The tool creates a webhook as the OAuth redirect target. It rebases the webhook on
  `SYM_SIGNIN_URL`, else `SYM_CALLBACK_URL`: an address the owner's browser can reach. It
  refuses a base that is not https unless the host is loopback.
- Discovery, registration, PKCE, and the token exchange run in steps through
  `lib/workers/t3/oauth.ts`, which `pnpm t3:login` also uses. Each sign-in registers again.
- The T3 link goes to the owner's DM through the outbox, with `chooseDisplay` and
  `needsAction`. It never goes to a shared thread or a log.
- The tool waits up to 10 minutes. A request without the sign-in's `state` is ignored, so a
  stray visit cannot end the sign-in. A wrong `iss`, or a missing `iss` when T3 says it sends
  one, refuses the sign-in (RFC 9207). The browser gets a plain page that sends the owner back
  to Slack, because the exchange runs after the page answers.
- The token goes to `worker_credentials` in Postgres: one row per worker name (the pack's first
  worker, else `default`) with the MCP URL, the expiry, and the approver. Errors from the store
  never carry the token.
- Sym finds the worker in this order: the stored sign-in, then the pack worker's `mcpUrl` with
  `T3_TOKEN`, then `T3_MCP_URL` with `T3_TOKEN`. A stored sign-in for another URL than the
  configured one is stale and does not count. The expiry notice reads the stored row, else
  `T3_TOKEN_EXPIRES_AT`, and tells the owner to ask Sym to sign in.
- With no worker URL and token at all, reconcile logs one warning per pass and skips the worker
  pass. Jobs stay as they are. A failed connection is still an outage and marks jobs offline.

## Consequences

- The owner renews the sign-in from Slack. `T3_TOKEN` and `pnpm t3:login` stay as a fallback for
  local runs.
- A deployment needs an https base for the redirect. Sym's public route already serves
  `/.well-known/workflow/`, so its public base works as `SYM_SIGNIN_URL`. A private-network
  `SYM_CALLBACK_URL` on plain http does not.
- The token sits in Postgres in plain text. Postgres access is already a secret boundary
  (`DATABASE_URL`), but a database backup now holds a worker token.
- The workflow journal holds the PKCE verifier, the T3 link, and the redirect request with its
  code. The code is single use and lives 60 seconds, and Sym redeems it at once. Protect the
  workflow data volume like the database. The token stays inside one step and never reaches the
  journal.
- Sym connects to one worker. A pack project on another worker is refused before launch.
