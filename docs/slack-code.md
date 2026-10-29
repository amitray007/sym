# Slack Code API reference

Slack Code gives an agent app a code channel for each task. Slack made the API generally available
on 2026-10-28. This page records what the API offers and which parts Sym uses (decision 067).
Source: the docs.slack.dev pages listed below, read 2026-10-29, and Slack's sample coding agents
(`slack-samples/bolt-js-coding-agent`, `slack-samples/bolt-python-coding-agent`).

## What a code channel is

- A normal Slack channel for one agent task. Slack calls it semi-ephemeral: the app archives it
  when the task ends. Archived channels stay searchable, and a person can reopen one.
- The app creates it from an origin message. Slack then links it in the origin conversation,
  invites the origin message's author, and matches the origin's privacy.
- The app sets a status, a context bar of links, and view tabs. Everyone in the channel sees
  them.
- The whole channel is one session. Messages need no mention. The app posts top-level, or in a
  thread when a person wrote in one.
- An app recognizes a code channel with `conversations.info`:
  `properties.record_channel.record_type` is `agent_channel`.

## Manifest and scopes

| Item | Value |
|---|---|
| `features.code_channels.enabled` | `true` turns the feature on |
| `features.code_channels.slash_command_url` | Optional. Where runtime-registered slash commands go. Max 3000 characters. Not needed for Socket Mode |
| `features.code_channels.suppress_mention_ephemeral` | Optional, default `true` |
| `code_channels:manage` | Bot token. Covers every `agents.conversations.*` method |
| `chat:write` | `agents.sessions.setStatus` and `agents.sessions.rename`, and the session events |
| `channels:read`, `groups:read` | `conversations.info`, to tell a code channel apart |
| `channels:history`, `groups:history` | Messages in the channel (`message.channels` and `message.groups` cover code channels) |

## Methods

Every method takes form or JSON bodies and needs a bot token. Calls other than `create` must
come from the channel's agent bot or a member. A call on a normal channel fails with
`not_agent_channel`; another bot gets `not_authorized`.

| Method | Purpose | Key arguments and limits |
|---|---|---|
| `agents.conversations.create` | Creates a code channel | `name`, `session_id` (idempotency: the same ID returns the same channel), `origin_channel_id` + `origin_message_ts`, `is_private`. Refuses a Slack Connect, DM, or group DM origin. Errors include `feature_disabled`, `user_not_enabled`, `invalid_origin_link`, `origin_channel_externally_shared`, `restricted_action` |
| `agents.conversations.archive` | Archives the channel | `summary_message_ts`: a message Slack shares as a reply on the origin message. Errors include `already_archived`, `no_origin_link`, `summary_message_not_found` |
| `agents.conversations.setProperties` | Context bar and resource details | `code_channel.context_bar_items`: at most 5; each call replaces the whole bar. Item: `key` (64), `label` (128), `icon` (`branch`, `folder`, `hierarchy`, `life-ring`, `link`, `globe`, `terminal`, `code`, `search`, `lock`), `url` (2048), `item_type` (`info` or `action`) |
| `agents.conversations.setCommands` | Per-channel slash commands | At most 10 per channel. Name 1 to 31 characters, no leading slash |
| `agents.conversations.setView` | Adds or updates a tab | Types `html`, `diff`, `block_kit`, `canvas`, `pull_request` (`pr_url`). At most 5 views, one diff. `content` up to 1,000,000 bytes. Keyed by `view_key` |
| `agents.conversations.listViews` | Lists the tabs | Use it to restore state after a restart |
| `agents.conversations.removeView` | Removes a tab | `view_key` or `view_id` |
| `agents.conversations.getCanvas` | Reads a plan canvas and its comments | At most 100 comment threads, 100 replies each |
| `agents.conversations.setCanvasContent` | Replaces a canvas, keeping comments on unchanged sections | Markdown |
| `agents.sessions.setStatus` | Session status | `active`, `processing`, `suspended` (waiting on a person), `closed`. Omit `thread_ts` for a code channel. `processing` times out after an hour |
| `agents.sessions.rename` | Session title; renames the code channel | 1 to 200 characters |

## Events

| Event | When |
|---|---|
| `app_mention` | A person mentions the app, including inside a code channel |
| `message.session` | Messages in code channels and session threads only |
| `agent_session_stopped` | A person clicks Stop while the session is `processing`. The app must leave `processing` itself |
| `agent_session_title_changed` | A person renames the session |
| `code_channel_action` | A person clicks a context bar item with `item_type: "action"` (its payload is not documented yet) |
| `channel_archive`, `group_archive` | Someone else archived the channel |

## Not available yet

Slack lists these as coming soon: GitHub review requests from Slack, two-way comment sync, a merge
prompt once a PR is approved and its checks pass, and a wider Agents & tools tab. The
`connect_domains` part of an HTML view's CSP is stored but not applied.

The help center still says that code channels "can currently be created only with supported
agents", while the GA post opens the API to any app. A refusal comes back as `feature_disabled`.
Sym keeps the job in its thread when that happens.

## What Sym uses

| Part | Use |
|---|---|
| `create` | On Start, with the person's message as the origin and `sym-J-<id>` as `session_id` |
| Context bar | The job, its project, and its pull request |
| Status | `processing` while the worker runs, `suspended` while a question waits, `active` when the job ends, `closed` before archive |
| `archive` | On Close, with the result post as the summary |
| Eve `codeChannels` | Eve serves the channel as one session, so messages need no tag |

Not used yet: view tabs (a diff needs the worker's diff), canvases, per-channel slash commands,
and Stop on the session (Eve stops the brain's turn, not the worker job).

## Sources

- https://docs.slack.dev/ai/slack-code
- https://docs.slack.dev/ai/slack-code/lifecycle
- https://docs.slack.dev/ai/slack-code/code-channel-properties
- https://docs.slack.dev/ai/slack-code/agent-slash-commands
- https://docs.slack.dev/ai/agent-sessions
- https://docs.slack.dev/reference/methods/ (one page per method above)
- https://slack.com/blog/developers/slack-code-api
- https://slack.com/help/articles/54310833022355-Build-with-AI-as-a-team-using-Slack-Code
