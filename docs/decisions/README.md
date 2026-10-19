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
