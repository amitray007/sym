# 091. GitHub and Linear channels

Status: accepted
Date: 2026-11-03

## Context

Decisions 088 and 090 let Slack events and signed webhooks fire an instruction. Teams also want
Sym to react to GitHub and Linear: "when a PR is opened in example-org/example-app, summarize
it", "when a check suite fails on main, tell #ops", "when an issue is created in team ENG, look
for duplicates". People also mention a GitHub App in a pull request, or delegate a Linear issue
to an agent, and expect the agent to pick it up. Eve ships a GitHub channel and a Linear channel
that verify those webhooks and normalize their events. Both expect to host the conversation on
their own surface, while Sym's tools, Builder's Start / Not now, and its consent rules live in
Slack.

## Decision

1. `agent/channels/github.ts` wraps Eve's `githubChannel` and `agent/channels/linear.ts` wraps
   `linearChannel`. Eve verifies each webhook with the app's secret. Route paths compile at build
   time, so the routes always exist; while `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and
   `GITHUB_WEBHOOK_SECRET` (or `LINEAR_WEBHOOK_SECRET` and a Linear access token) are not all set,
   the route answers 404 and does nothing. No other code needs the variables, so nothing fails at
   start.
2. Every hook returns no dispatch: no session runs on GitHub or in Linear. Sym never edits
   repositories itself, and the GitHub App needs only read permissions, plus comment write for
   mention replies.
3. A trigger can have kind `github` or `linear`. Like a webhook trigger it watches no Slack
   channel, has a title, an instruction, a Builder mode, a destination (this conversation by
   default), and a creator, and anyone on the allow-list creates one with no owner approval.
   `source_filter` holds a GitHub repository (`owner/name`), event types (`pull_request`,
   `issues`, `check_suite`, `issue_comment`; empty means all four), actions, an optional label,
   and an optional branch (a pull request's base or a check suite's branch); or a Linear team key,
   actions, and an optional label for issue events. Setup refuses while the app is not set up.
4. Each matching event reserves one deferred run per trigger, keyed by the delivery ID, so a
   redelivery fires nothing, under the hourly cap of decision 088. Eve's hooks have no `to()`, so
   the next `dispatch` tick sends the run as the app principal into a new thread at the
   destination, within a minute, under the dispatcher's 2-minute lease. After the reservation,
   and again before the send, the creator must be on the allow-list and, for a channel
   destination, still a member of it; otherwise the run fails. The run acts for the creator, and
   every turn of its session counts as having read untrusted content. The run message carries the
   event's facts (repository, number, title, link, sender, labels, branch, conclusion, and body
   cut at 2,000 characters) as untrusted JSON data that grants no consent; whoever acted on GitHub
   or Linear is not the requester. `worker_job` keeps the rules of decisions 085 and 088: only an
   active `auto` trigger's own run skips Start, once.
5. Comments by bots fire nothing, so Sym's own reply comments cannot fire a trigger. Pull request,
   issue, and check suite events fire whoever sent them, because CI and bots send many of them;
   each delivery fires once and the hourly cap bounds a loop through Builder's own pull requests.
6. The decision 042 project list does not map to repositories. Which repositories Sym sees is the
   owner's choice when installing the GitHub App; any Builder work a run starts still needs a
   project on the list.
7. A mention and a delegation are person-initiated requests, handled like Send to Sym (decision
   088): Sym never hosts them on GitHub or in Linear, because Builder's Start and the tools work
   from Slack. A GitHub comment that mentions `@<GITHUB_APP_SLUG>`, or a Linear Agent Session
   (`created` or `prompted`), counts only when an explicit mapping names the user: the pack's
   `identities` (`slackUserId` with `github` login and `linear` email or user ID), or without a
   pack `SYM_GITHUB_USERS` and `SYM_LINEAR_USERS`. The mapped person must be on the allow-list.
   Sym never matches on a display name. Then Sym posts in that person's Slack DM: a link, a quote,
   and "What should I do with it?". Their reply is their own request, with the usual Start / Not
   now, and the brain gets the note that the quote is data. Sym answers on GitHub with a comment,
   or in Linear with a `response` activity, saying where to continue. Anyone else gets a polite
   refusal there. Without `GITHUB_APP_SLUG`, Sym ignores mentions.
8. Migration `041_source_triggers` adds kinds `github` and `linear` and `source_filter`, with a
   check that exactly those kinds have a filter and that every kind but a Slack one has a
   destination.

## Consequences

- Each app is an owner action: create it, grant the permissions, set the variables, expose the
  route, and map people. Slack scopes do not change.
- A GitHub or Linear run starts up to a minute after the event.
- A mention or a delegation needs one more step from the person: they reply in Slack. Answering
  in place, on GitHub or in Linear, is later; it needs Builder's Start and the reach tools to
  work outside Slack.
- Any allowed person can route events from any repository the app is installed on into a channel
  they share with Sym, including a private repository's titles and bodies.
- Linear issue events need the Issue data webhook; Eve's channel passes them through
  `onDataWebhook`.
