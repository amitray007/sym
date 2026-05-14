# 08 — Platform adapters

## Why an adapter layer

We ship Slack-only at v1. The adapter layer exists so we don't paint
ourselves into a corner. Teams customers and Discord communities are
real markets we want to address without rewriting half the codebase.

The adapter layer is a *boundary*, not an *abstraction over the
lowest common denominator*. Every platform has features the others
don't. The adapter lets us:

- Speak each platform's API in its idioms (no awkward
  pseudo-standard).
- Lift events into a shared internal schema for the runtime.
- Surface platform-specific capabilities to skills that want them
  (Slack canvases, Teams adaptive cards, Discord embeds).

## Internal event schema

Every adapter normalizes to a `NormalizedEvent`:

```ts
type NormalizedEvent =
  | { kind: "message"; payload: MessagePayload }
  | { kind: "mention"; payload: MentionPayload }
  | { kind: "reaction_added"; payload: ReactionPayload }
  | { kind: "reaction_removed"; payload: ReactionPayload }
  | { kind: "thread_reply"; payload: MessagePayload }
  | { kind: "member_joined"; payload: MembershipPayload }
  | { kind: "member_left"; payload: MembershipPayload }
  | { kind: "channel_created"; payload: ChannelPayload }
  | { kind: "channel_archived"; payload: ChannelPayload }
  | { kind: "slash_command"; payload: SlashCommandPayload }
  | { kind: "interactive"; payload: InteractivePayload };  // buttons, modals

interface MessagePayload {
  platform: "slack" | "teams" | "discord";
  orgId: string;             // resolved
  channelId: string;
  threadId?: string;
  authorPlatformUserId: string;
  authorOrgUserId: string;   // resolved
  text: string;
  attachments?: Attachment[];
  permalink: string;         // platform-native
  raw: unknown;              // platform-specific original
  receivedAt: number;
}
```

`raw` is escape-hatch territory; skills that need platform-specific
metadata can pull from it.

## Internal action schema

Each adapter implements:

```ts
interface Adapter {
  // Identity
  install(orgId: string, installerUserId: string): Promise<InstallResult>;
  listChannels(orgId: string): Promise<Channel[]>;
  checkChannelAccess(orgId: string, channelId: string, userId: string): Promise<AccessResult>;

  // Messaging
  postMessage(target: ChatTarget, content: ChatContent): Promise<MessageRef>;
  postEphemeral(target: ChatTarget, userId: string, content: ChatContent): Promise<void>;
  editMessage(messageRef: MessageRef, content: ChatContent): Promise<void>;
  deleteMessage(messageRef: MessageRef): Promise<void>;
  addReaction(messageRef: MessageRef, emoji: string): Promise<void>;

  // Threads
  openThread(messageRef: MessageRef): Promise<ThreadRef>;
  readThread(threadRef: ThreadRef, opts?: ReadOpts): Promise<Message[]>;
  readChannelHistory(channelId: string, opts?: ReadOpts): Promise<Message[]>;
  readFile(fileRef: FileRef): Promise<FileContent>;

  // Rich surfaces
  postCanvas?(target: ChatTarget, canvas: Canvas): Promise<CanvasRef>;   // Slack/Teams
  postCard?(target: ChatTarget, card: Card): Promise<MessageRef>;        // adaptive cards / blocks
  openModal?(triggerId: string, modal: Modal): Promise<void>;            // Slack/Teams

  // Typing & presence
  startTyping(target: ChatTarget): Promise<void>;
}
```

Capabilities that don't exist on a platform return `undefined` from
the adapter export so callers can feature-test:

```ts
if (adapter.postCanvas) {
  await adapter.postCanvas(target, …);
} else {
  await adapter.postMessage(target, longFormFallback);
}
```

Skills declare their preferred surfaces in their manifest; the
runtime picks the best supported one.

## Platform-specific notes

### Slack (reference adapter)

- **Events API + Web API + Socket Mode optionally for self-host.**
- **OAuth scopes**: minimal set at install (`chat:write`,
  `channels:history`, `groups:history`, `im:history`,
  `mpim:history`, `users:read`, `team:read`, `files:read`,
  `commands`). Optional: `canvases:read/write`, `reactions:write`,
  `mpim:write`, `chat:write.public`.
- **Channel join model**: the bot only sees channels it's invited
  to. We surface a `/sym invite-here` shortcut.
- **Threading**: Slack uses `thread_ts`; we mirror it as `threadId`.
- **Canvases**: when available, used for long-form output (digests,
  reports).
- **Slash commands**: `/sym`, `/sym-task`, `/sym-config`, `/sym-skill`.

Slack quirks to handle:

- Coalesced edits in slow-mode channels arrive as new events; we
  dedupe via `client_msg_id` + content hash.
- `chat.postMessage` with `thread_broadcast=true` makes a message
  visible in channel; we wrap this in a high-friction confirm.
- Slack's rate limits are tier-based; the adapter tracks per-team
  budgets.

### Microsoft Teams

- **Bot Framework + Graph API**.
- **OAuth**: trickier. Two flows: bot-resource (app-scoped) and
  delegated (user-scoped) via SSO.
- **Channels = Teams channels**; tenants = orgs.
- **No real ephemeral messages** in the channel surface; we use DMs
  for similar effect.
- **Adaptive Cards** are first-class — equivalent to Slack blocks
  but richer.
- **Tabs and apps**: a Teams tab can host the Sym admin UI directly.
- **Threading**: channel conversations have replies; group chats
  do not. The adapter normalizes both into thread-replies.

Teams quirks:

- The Bot Framework's middleware model is heavier than Slack's
  webhooks. Plan for it.
- Teams' typing indicator is `sendTypingActivity` and isn't as
  reliable.
- Compliance: many Teams customers want EU/data-residency from day
  one. Teams adapter ships with region-aware endpoints.

### Discord

- **Gateway + REST**.
- **Servers = orgs** (one-to-one in most communities).
- **Channels = text channels**; threads are first-class.
- **Discord is *less* work-oriented**; expect heavier emoji policy,
  more casual tone by default.
- **OAuth**: bot token + optional user OAuth for actions on
  behalf-of.
- **Embeds** are the rich surface (no native canvas).
- **Voice channels** out of scope.

Discord quirks:

- Bots are expected to be more performative; we expose a
  `verbosity: chat-native` mode for Discord servers.
- Different intents grant different event visibility (Privileged
  Intents). We document scope at install.

### Mock adapter

For testing and local dev: an in-process adapter that replays
events from JSON files. Useful for CI of skills and the runtime
without spinning up real platforms.

## Identity resolution across adapters

Already covered briefly in `02-architecture.md`. The contract:

- Each adapter exposes a `resolvePlatformUser(orgId,
  platformUserId)` → `OrgUser`.
- Resolution uses SSO claims (preferred), SCIM-provisioned email
  (if available), or platform email (lowest priority).
- A user's first contact on a new platform may prompt a
  link-existing-account flow (DM-based).

A single `OrgUser` may carry `platformIdentities: { slack:
"U12345", teams: "abcd-…", discord: "12345…" }`.

## Per-platform configuration

Per-platform admin UI:

- **Slack**: app home tab with admin controls.
- **Teams**: a Teams app tab for admin controls.
- **Discord**: a `/sym admin` slash command + web fallback.

Behind the scenes, the same admin API.

## Webhook security

- Slack signing secret (HMAC-SHA256) with replay protection (5-min
  window).
- Teams JWT validation (Microsoft public keys, issuer + audience
  checks).
- Discord Ed25519 signature with public key.

The ingress layer normalizes verification; adapter modules supply
the verifier.

## Disconnect / reconnect

- Adapters maintain a persistent connection (Socket Mode for Slack
  self-host; webhook for Slack hosted; Gateway for Discord; long-
  poll or webhook for Teams).
- Reconnect logic uses exponential backoff with jitter.
- Events received during a disconnect are replayed on reconnect
  where the platform supports it; we log gaps where it doesn't.

## Decisions

- **Per-platform adapter modules** with a shared event schema.
- **No "lowest common denominator" abstraction**; capabilities are
  feature-tested.
- **Identity is org-level**, mapped from per-platform IDs.
- **Mock adapter** for testing.
- **Webhook signature verification** mandatory.

## Open questions

- IRC / Matrix / Mattermost demand? Probably long tail; not in
  v1/v2.
- Email adapter: Sym replies to a thread via email when the
  workspace is offline. Possibly useful for receipts/digests; not
  v1.
- Shared adapter test suite (run the same compliance tests against
  every adapter): worth investing in once we have two adapters
  shipping.
