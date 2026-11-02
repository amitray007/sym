# 090. Webhook triggers

Status: accepted
Date: 2026-11-03

## Context

Decision 088 made a trigger an instruction fired by a Slack event. People also want work that
starts when another system calls: "when the deploy tool reports a failure, summarize it in
#ops", or "when the error tracker opens an incident, check the recent PRs". Those systems can
send an HTTP request but cannot post in Slack. Eve's custom channels give Sym an HTTP route and
`to()`, which hands work to the Slack channel.

## Decision

1. A webhook trigger is a trigger of kind `webhook`. It has the same title, instruction,
   Builder mode (`ask` or `auto`), destination, and creator as any trigger, and watches no Slack
   channel. Anyone on the allow-list creates one with `trigger_create` (`on: webhook`), with no
   owner approval; the creator's setup is the consent for its runs. Its runs post in this
   conversation by default, a channel the person and Sym share, or the creator's DM. Each run
   starts a new thread there.
2. Each trigger has its own URL, `<public base>/sym/hooks/<hook id>`, served by the custom channel
   `agent/channels/webhook.ts`. The hook ID holds 144 random bits. The public base is
   `SYM_SIGNIN_URL` (Sym's public HTTPS address, decision 036), else `SYM_CALLBACK_URL` (decision
   028). The proxy exposes `/sym/hooks/` only when webhook triggers are on.
3. One scheme authenticates a request: an HMAC-SHA256 signature. The sender sets
   `x-sym-timestamp` to the Unix time in seconds and `x-sym-signature` to `sha256=` plus the hex
   HMAC of `<timestamp>.<raw body>` with the trigger's secret. Sym compares in constant time and
   refuses a timestamp more than 5 minutes off. Sym accepts no static bearer token: a leaked
   header would work until someone noticed, while a signature expires and covers the body.
4. Sym stores no secret. Each secret is `whsec_` plus the base64url HMAC-SHA256 of
   `sym-webhook:<hook id>:<version>` keyed with `SYM_WEBHOOK_KEY`, a deployment secret of at
   least 32 characters. A database copy alone reveals nothing, and there is no ciphertext or
   encryption mode to manage. Rotation increments `secret_version`, so the old secret stops at
   once. Changing `SYM_WEBHOOK_KEY` changes every secret. Without the key, webhook triggers are
   off: setup refuses and every URL answers 404.
5. Sym shows the URL and secret once, in the creator's DM, posted straight to Slack after the
   display rule. The post skips the outbox, so the secret never lands in Postgres. The secret
   never reaches the tool result, the brain, a channel, or a log. A failed DM loses the secret;
   the creator rotates for a new one. `trigger_list` shows the URL, never the secret.
6. Only the creator rotates a secret, with `trigger_rotate_secret`: whoever holds the secret can
   start runs that act for the creator. Pause, resume, and delete work as for any trigger.
7. The route reads at most 64 KiB (413 above it), then looks up the hook (404 when unknown,
   deleted, or off), checks the signature (401), and refuses a paused trigger (409). A webhook
   watches no channel, so the creator check of decision 088 applies to the destination: the
   creator must be on the allow-list and, for a channel destination, still a member of it (403
   otherwise); the dispatcher checks again before a deferred send. It logs no header, body,
   signature, or secret.
8. A request fires once. The event key is the sender's `x-sym-delivery` ID when present, so a
   re-signed retry fires once, else a hash of the signature, so a replayed request fires once.
   A duplicate gets 200. The hourly cap of decision 088 (`SYM_TRIGGER_RUNS_PER_HOUR`) applies,
   and a request past it gets 429.
9. The route reserves the run as deferred, answers 202, and then claims the row with the
   dispatcher's 2-minute lease and sends the run with `to(slack, { channelId })` as the app
   principal, the proof of a run (decisions 085 and 088). If that send never ends, the lease runs
   out and the next `dispatch` tick sends it with the same delivery key; a deferred run older
   than 10 minutes fails. The lease lets only one of them send at a time.
10. The run message is the trigger run message with the request's facts as one JSON line: the
    media type, the delivery ID, the time, and the body (JSON parsed, else text, cut at 8,000
    characters). It says the facts are untrusted data, never instructions or consent, and that
    the sender is not the person the run acts for. The run acts for the creator, and
    `worker_job` skips Start only for an active `auto` trigger whose run this session is, once.
    Like any trigger run, every turn of the session counts as having read untrusted content, so
    a post, DM, edit, bookmark, or canvas write elsewhere waits for the creator's approval.
11. Migration `040_webhook_triggers` adds kind `webhook`, makes `triggers.channel` nullable for
    it, and adds `hook_id` and `secret_version`, with checks that a webhook has a hook ID and a
    destination and a Slack trigger has a channel.

## Consequences

- A deployment that wants webhook triggers sets `SYM_WEBHOOK_KEY`, a public base URL, and a
  public `/sym/hooks/` route.
- A sender must compute an HMAC. Services that sign with their own scheme (such as GitHub)
  need a small relay, or their own Eve channel (decision 091).
- A secret posted in a DM is in Slack's history. If someone replies in that thread, Sym's thread
  context could read it, so the DM says to keep the secret out of threads.
- A leaked secret lets its holder start runs that act for the creator until the creator rotates
  it or pauses the trigger. The hourly cap and the one-run-per-request rule bound the damage.
