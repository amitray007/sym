# Decisions

One record per accepted decision. Add the next number, then add a row here.

Format: title, `Status`, `Date`, then Context, Decision, and Consequences. One short paragraph each is enough.

| No. | Decision |
|---|---|
| [001](001-generic-self-hosted.md) | Generic, self-hosted, open source |
| [002](002-eve-as-the-brain.md) | Eve is the brain |
| [003](003-worker-adapters.md) | Workers behind adapters, T3 Code first |
| [004](004-ledger-is-the-truth.md) | The Postgres ledger is the source of truth |
| [005](005-job-card.md) | Sym owns one job card per long job |
| [006](006-public-slack-route.md) | Only the Slack route is public |
| [007](007-learning-layers.md) | Learning in three layers, code through worker PRs |
| [008](008-sym-owns-schedules.md) | Sym owns schedules, not the worker |
| [009](009-t3-access-auto.md) | Default T3 access level is Auto |
| [010](010-adopter-packs.md) | Adopter specifics live in packs |
| [011](011-display-rule-in-code.md) | The display rule lives in code |
| [012](012-mit-license.md) | MIT license |
| [013](013-project-tooling.md) | Project tooling |
| [014](014-local-postgres.md) | Local Postgres and the database client |
| [015](015-adapter-mcp-client.md) | Worker adapters call the worker from code |
| [016](016-ledger-migrations.md) | Ledger migrations live in code |
| [017](017-t3-job-task.md) | `t3_job` is a task with ledger-backed steps |
| [018](018-gateway-model.md) | The brain model goes through the AI Gateway |
| [019](019-container-image.md) | Container image and API token |
| [020](020-job-presentation.md) | The ledger holds the job card, and delivery syncs it |
| [021](021-brief-approval-in-task.md) | The owner starts each job from the brief |
| [022](022-reconcile-drives-orphans.md) | Reconcile drives orphaned jobs in code |
| [023](023-local-end-to-end.md) | Local end-to-end runs use fakes and a fixture brain |
| [024](024-schedule-rows.md) | Schedules are approved rows behind one dispatcher |
| [025](025-postgres-memory.md) | Memory lives in Postgres, per person |
| [026](026-pack-format.md) | The pack manifest is validated YAML without secrets |
| [027](027-worker-mcp-channel.md) | Worker threads call Sym through the MCP channel, and tools check the caller |
| [028](028-callback-base-url.md) | The worker callback uses a configured base URL |
| [029](029-quiet-buttons-feedback.md) | Quiet mode, the slash command, card buttons, and feedback |
| [030](030-pack-enforcement-and-checks.md) | The pack shapes each launch, and results get rule checks |
| [031](031-silent-scheduled-checks.md) | A clean scheduled check posts nothing |
| [032](032-verifier.md) | A verifier subagent checks code results before they post |
| [033](033-playbook-rows.md) | Approved playbook rows load as instructions at session start |
| [034](034-follow-prs-and-sign-in.md) | Reconcile follows pull requests and the worker sign-in |
| [035](035-pack-overlay.md) | The pack overlay copies instructions and playbooks before the build |
| [036](036-in-app-worker-sign-in.md) | The owner signs Sym in to the worker from Slack |
| [037](037-review-fixes.md) | Fixes from the first independent review |
| [038](038-second-review-fixes.md) | Fixes from the second independent review |
| [039](039-evals.md) | Evals check the brain's routing with a real model, with stubbed tools |
| [040](040-reference-compose.md) | One compose file runs the local lab and the deployment |
| [041](041-worker-model-choice.md) | The brain picks a worker model per job from an allow-list with a purpose per model |
| [042](042-project-allow-list.md) | Sym touches only the projects on its allow-list, and refuses all others in code |
| [043](043-worker-label.md) | Slack shows the worker under a configurable label, never the software behind it |
| [044](044-voice-and-personas.md) | The brain has a persona, and Sym's own messages are short, structured, and neutral |
| [045](045-mcp-connections.md) | The owner connects MCP servers from Slack; tokens come from `SYM_MCP_<NAME>_TOKEN` or an OAuth sign-in |
| [046](046-persona-from-slack.md) | The owner switches the persona from Slack, and the status line rotates persona-flavored loading messages |
| [047](047-blockkit-results.md) | Result and failure posts are Block Kit with a mrkdwn fallback, and the feedback buttons have an off switch |
| [048](048-mcp-server-instructions.md) | The model reads an MCP server's `initialize` instructions through the connection description; code-mode servers work as ordinary connections |
| [049](049-connection-default-mode.md) | A connection has a default tool mode: a tool's own mode, then the connection default, then the read-only hint |
| [050](050-shared-threads.md) | In a thread with several people, Sym answers only a message meant for it, with a quiet turn for the unclear ones, a per-thread listen mode, and a lighter thread context |
| [051](051-reactions.md) | Sym reacts with emoji on a clear trigger through `slack_react` and `slack_emoji`; code caps one per message and three per thread per hour, and never uses 👀 |
| [052](052-app-home.md) | The App Home tab is a read-only dashboard: jobs, schedules, projects, and owner-only connections; `views.publish` is the one Slack write outside the outbox |
| [053](053-stranger-replies.md) | A person off the allow-list who tags Sym, writes to it, or names it in a thread gets one private persona line per hour that points to the owner, with no model call and an off switch |
| [054](054-opt-in-proactive-features.md) | The daily digest, the verifier, and PR follow are off unless `SYM_DIGEST`, `SYM_VERIFIER`, or `SYM_PR_FOLLOW` is on |
| [055](055-pack-schedules.md) | A pack's `schedules.yaml` seeds schedule rows as `pending_approval`; the owner approves each once with `schedule_approve`, a changed brief asks again, and a removed key is deleted |
| [056](056-result-buttons.md) | The card has Steer and the result has Looks good, Fix, and Close; Steer and Fix post a text box, a Fix runs as a follow-up job on the same worker thread, and Close settles it |
| [057](057-pr-fact-checks.md) | A finished code job stores the worker's pull request facts and runs generic rule checks on them; the verifier judges production-touching changes; CI status comes only from PR-follow wakes |
| [058](058-repeated-work.md) | A weekly review lets the brain find repeated work in recent briefs and draft playbooks for the owner to approve |
| [059](059-trust-ladder.md) | Playbook links and outcomes; auto-start and promotion superseded in part by 071 |
| [060](060-short-brief.md) | The brief post shows the title, project, delivery, model, and playbook; a Full brief button sends the goal, constraints, and done-when list privately |
| [061](061-whole-last-message.md) | The job check reads the worker's last message whole, because its result block comes last; it keeps the last 20,000 characters, and a failed read keeps the cut text |
| [062](062-written-results.md) | The `writer` subagent writes a finished code job's result in the persona's voice with no template; Sym keeps the concerns list, a footer, and the buttons; the brain's Voice rules drop the fixed shape |
| [063](063-quick-checks-without-a-job.md) | The brain answers quick checks itself with its tools and connections; only code changes, work that needs the repository checked out, and long investigations become worker jobs |
| [064](064-eval-findings.md) | Fixes from the first real-model eval run: `SYM_REASONING` for models without reasoning, no job writes production data, short job offers, a real `worker_job` stub, and an eval setup with its own database |
| [065](065-security-boundaries.md) | Proposals stay anonymous, Fix rechecks current policy, and worker callbacks use job-scoped credentials |
| [066](066-eve-088.md) | Eve 0.88.0, for Slack code channels: dynamic capabilities with `ctx.memo`, the `sessionUsage` limit, a v27 Slack renderer, and `onAnswers`; free-text answers go through Eve's answer box |
| [067](067-code-channels.md) | With `SYM_CODE_CHANNELS` on, a started job moves into its own Slack code channel with a status and context bar; Close archives it; a Slack refusal keeps the job in its thread |
| [068](068-capabilities-and-code-channel-tool.md) | A dynamic instruction tells the brain which opt-in features are on; with code channels on, a `code_channel` tool moves a conversation into a code channel, and a job started there adopts it |
| [070](070-conversational-jobs.md) | Conversational jobs: working notes, human results, stored choices, follow-up proposals, and recoverable closure |
| [071](071-voice-and-builder-consent.md) | One colleague voice and explicit consent before Builder work, including investigations |
| [072](072-followup-run-boundaries.md) | Follow-ups store a run boundary, bound empty completion, and preserve same-key children |
| [073](073-name-the-work.md) | People see work titles; job and schedule references remain internal handles |
