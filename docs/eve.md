# Eve features

Sym runs on [Eve](https://eve.dev) (npm `eve`, Apache-2.0, Node 24 or later). This page records
which Eve features Sym uses and the limits that shape the design. Source: the Eve docs corpus at
https://eve.dev/llms-full.txt, read 2026-10-19 against version 0.81.0. Pin the Eve version in
`package.json`.

Legend: **Use** = part of the design. **Later** = after milestone 1 or in the team phase.
**Skip** = not needed.

## Core

| Feature | API | Decision | How Sym uses it | Limits |
|---|---|---|---|---|
| Agent definition | `agent/agent.ts` `defineAgent` | Use | Model, limits, compaction | Self-hosted upgrades strand running sessions |
| Model | Gateway model ID from `SYM_MODEL`, set at `session.started` (decision 018) | Use | Chat, briefs, triage, summaries. Workers do heavy work | Needs `AI_GATEWAY_API_KEY` off Vercel. The model is fixed per session |
| Dynamic model | `defineDynamic` on `turn.started` | Later | Cheap model for status, stronger model for planning | Switching mid-session loses the prompt cache |
| Spend limits | `limits.maxTokenCostUsdPerSession` | Use | $2 of brain model cost per session, then Eve asks to continue or stop (`agent/agent.ts`) | Cost tracking needs reported cost |
| Instructions | `agent/instructions.md`, `instructions/` | Use | Persona, trust ladder, Slack style | TS instructions evaluate at build time |
| Skills | `agent/skills/*.md` | Use | Pack playbooks through the overlay (decision 035). The brief rules live in `agent/instructions.md`, and the progress and result rules in code (`lib/jobs/progress.ts`, `lib/jobs/verify.ts`) | Supporting files need a sandbox |

## Tools and durable work

| Feature | API | Decision | How Sym uses it | Limits |
|---|---|---|---|---|
| Plain tools | `defineTool` | Use | `jobs_status`, `worker_projects`, `schedule_*`, memory tools | Not retried. Interrupted steps re-run, so use idempotency keys |
| Approvals | `approval: never/once/always/policy` | Use | Gate launches with write intent, schedule deletes, merges | Default `never`. Check the clicker in `onInputResponse` |
| Workflow task | `defineWorkflowTool({ task })` | Use | `worker_job`: one worker thread from launch to checked result | 32 working tasks per session. Result capped at 50 KB |
| Progress | `async *task` + `yield` | Use | The thread status line | The task card row does not show yields. `serve` tasks cannot yield |
| Questions | `ctx.ask` | Use | Worker questions become Slack buttons | `unavailable` in Markdown schedule sessions |
| Durable timer | `sleep()` from `workflow` | Use | Waits between worker checks, no compute | |
| Callback URL | `createWebhook()` | Use | The worker POSTs its result for instant completion | Race with `sleep()` for the polling fallback |
| Subagents | `ctx.agent(name).send(msg, { outputSchema })` | Use | `verifier` (`tool: false`, no tools) checks a code result against the brief from the `worker_job` body (decision 032) | Body only, not in a step. Shares the parent's token budget |
| Fan-out | `workflow({ maxSubagents })` | Later | Parallel triage | The program cannot call tools |
| Opt-in tools | `no_reply` | Use | Silence for a clean scheduled check | |
| Default tools | `bash`, `web_fetch` | Skip most | Workers do repository work. `defaultTools: false` | |
| Sandbox | Docker, microsandbox, just-bash | Skip | Not needed while workers do the work | Docker needs the host socket |

## Channels

| Feature | API | Decision | How Sym uses it | Limits |
|---|---|---|---|---|
| Slack channel | `channels/slack.ts` `slackChannel` | Use | Main interface | HTTP Events API only. Needs a public HTTPS URL |
| Portable credentials | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | Use | Slack auth off Vercel | |
| Handlers | `onAppMention`, `onDirectMessage`, `onMessage` | Use | Allow-list check, then start work | First matching handler wins |
| Reply without mention | `onMessage` + `isSubscribed()` | Use | Replies in job threads without `@sym`, when the message is meant for Sym (decision 050) | Needs `message.channels` and history scopes |
| Dispatch context | `{ auth, context }` from a message hook | Use | A People note (who is in the thread, with roles) and a note on a message that did not tag Sym | Strings join the session history before the message |
| Thread context | `threadContext: { since: predicate }` | Use | A session's first turn reads the whole thread. Later turns read what came after Sym's last post | The predicate reads in-process state, so another instance reads the whole thread |
| Thread participants | `ctx.thread.listParticipants()` | Use | Tells a solo thread from a shared one | Sees the first 50 messages only. A failure reads as a shared thread |
| Task card | automatic, `taskCard` renderer | Use | Short non-job tasks. Hidden for `worker_job` | Rows show no progress. Schedule sessions get no card |
| Status line | tool `label.start`, `label.delta` | Use | "Launching worker thread", "Tests running" | Cut at 50 characters. Cleared after 2 min idle |
| Approval routing | `approvalChannel: "direct-message"` | Later | Approvals stay in the job thread for the owner-only allow-list; a DM route comes with team use | Fails closed if the user cannot be resolved |
| Renderers | `defineSlackRenderer` | Use | Feedback buttons inside each reply, the session's Slack thread, hiding Eve's card for `worker_job` | Clicks arrive in `onInteraction` |
| Events | `onEvent` | Use | `reaction_added` for feedback. `app_home_opened` publishes the Home tab (decision 052) | |
| Slash commands | `onSlashCommand` | Use | `/sym status`, `/sym jobs`, `/sym schedules`, `/sym quiet`, answered ephemerally with `ctx.slack.request` | No model call |
| Shortcuts | `onShortcut` | Later | "Send to Sym" on any message | `trigger_id` valid about 3 s |
| Proactive posts | `to(slack, { channelId, threadTs? })` | Use | Schedule threads, recovery sessions, digests | Each fire is a new session unless `threadTs` is set |
| Plain posts | `callSlackApi`, `ctx.slack.request` | Use | Outbox, job card edits, reactions | |
| MCP channel | `channels/mcp.ts`, `tools: true` | Use | Worker threads call `sym_post_progress`, `sym_ask_owner` with `SYM_MCP_TOKEN` | HTTPS unless loopback. No tool allow-list: every plain tool is published, so tools check the caller (decision 027). Workflow tools are never published. Approval tools return `approval_required` |
| HTTP channel | `/eve/v1/session` | Use | Scripts and CI start a session | Use `operationId` for create-once |
| GitHub channel | `githubChannel` | Later | CI and PR events instead of polling | Needs a GitHub App |
| Custom channel | `defineChannel` | Later | Error tracker or ticket webhooks | Verify signatures. Dedupe |
| Continuation aliases | `channel.continuation.alias()` | Later | Address a thread by worker thread ID or PR number | 256 per session |

## Schedules, memory, state, hooks

| Feature | API | Decision | How Sym uses it | Limits |
|---|---|---|---|---|
| Handler schedules | `defineSchedule({ cron, run })` | Use | `dispatch` (1 min), `reconcile` (3 min), `digest`, `learn` | Cron in UTC. `eve start` runs the scheduler. One replica |
| Markdown schedules | `.md` with `cron` | Skip | | Output discarded. Approvals fail the session |
| Dynamic scheduling | dispatcher + rows + CRUD tools | Use | Owner schedules as rows | At-least-once. Lease each row |
| Durable notifications | outbox + schedule + `callSlackApi` | Use | Posts that retry | At-least-once. Idempotency key per post |
| Memory | `defineMemory`, `defineMemoryProvider` | Use | Learning layer 1 | `fileMemory` needs Vercel Blob off Vercel, so Sym uses its own Postgres provider (`lib/memory/provider.ts`) in the `owner` slot. `byPrincipal` scopes it per person and gives schedule turns no memory |
| Session state | `defineState` | Use lightly | Per-thread scratch | Lost with the session |
| Hooks | `agent/hooks/*.ts` `defineHook` | Later | An audit log of turns, tool calls, and results in Postgres. Jobs already keep their own rows | Observe-only, at-least-once |
| MCP connections | `defineDynamic` in `agent/connections/rows.ts` with `defineMcpClientConnection` | Use | Owner-approved MCP servers load as connections at each turn (decision 045). `tools.block` hides tools; an `approval` request policy asks for `ask` tools; `ownerResponse` lets only the owner approve | Names allow only lowercase letters, digits, and dashes. An approval prompt reads only the tool input. Eve's interactive OAuth is user-scoped and posts in the thread, so Sym runs its own sign-in and passes the token through `getToken`. Eve does not show a server's `initialize` instructions or let a connection set a call timeout, so Sym appends the instructions to `description` (decision 048). Code-mode servers (few tools such as `search` and `execute`) connect like any server; their `execute` starts in `ask` mode unless the server marks it read-only, and `connection_tools` switches it. Without a `tool`, `connection_tools` sets a connection-wide default mode (decision 049): a tool's own mode, then that default, then the read-only hint |
| Dynamic capabilities | `defineDynamic` in `agent/instructions/playbooks.ts` | Use | Load approved playbooks and rules as system instructions on `session.started` (learning layer 2, decision 033) | Resolvers may re-run, so it is a pure read of approved rows, capped at 8000 characters |
| Compaction | `compaction`, `clear` | Use defaults | Long job threads stay usable | |

## Quality and operations

| Feature | API | Decision | How Sym uses it | Limits |
|---|---|---|---|---|
| Self-modification | `eve/self-modification/remote` | Skip | Code changes go through a worker thread instead (decision 007) | Needs microsandbox when self-hosted |
| Evals | `evals/**/*.eval.ts`, `eve eval`, tool stubs | Use | Six routing cases and three voice cases check the brain with a real model (voice: silence after a posted result, and two persona floors run by `pnpm eval:plain` and `pnpm eval:spicy`; decision 062 removed the shape cases). The routing cases: a code change calls `worker_job`, a quick pull request check starts no job (decision 063), a status question calls `jobs_status`, a recurring request calls `schedule_create`, a production write stays read-only, and injected text calls no write tool (decision 039). Stubs replace the write tools. `pnpm test:e2e` still covers the flows with the fixture brain | Run by the owner, not CI: it spends model tokens. Needs a migrated Postgres for memory, with no approved connections, so no eval reaches a live server. Stubs need the dev-only grant in `agent/channels/eve.ts`. No judge is used, so no judge model is set |
| OpenTelemetry | `agent/instrumentation/*` | Later | Traces to a collector | |
| Route auth | custom bearer `AuthFn`, `localDev()` | Use | Slack by signature. MCP by `SYM_MCP_TOKEN`, sessions by `SYM_API_TOKEN` (decisions 019, 027). An IP allow-list is later; keep both routes on the private network | `placeholderAuth` blocks production |
| Self-hosting | `eve build`, `eve start` | Use | Docker service with a volume at `.eve/.workflow-data` | The proxy must pass `/eve/` and `/.well-known/workflow/` unrewritten |
| CLI | `eve remote connect`, `eve logs`, `eve traces` | Use | Debug the deployed agent | CLI telemetry is on by default |

## What Eve cannot do here

- Receive Slack events without a public HTTPS endpoint.
- Learn on its own. It provides memory slots, hooks, and buttons. Sym builds the loop.
- Know about workers. It sees a worker only as an MCP connection.
- Answer "what is running?" across sessions. The ledger fills that gap.
- Keep running sessions across a self-hosted upgrade.
- Retry failed tools or deliver exactly once.
- Document Slack's agent surface or streamed replies. See [slack.md](slack.md).
