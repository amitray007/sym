/**
 * Built-in tool registry and Map-based dispatcher factory.
 *
 * Replaces the 866-line if/else chain with a `Map<name, handler>` lookup.
 * Each handler is a closure created once per `createBuiltinDispatcher` call
 * that captures the deps it needs (Slack clients, resolver, plan controller).
 *
 * The exported `BuiltinToolDeps` interface and `createBuiltinDispatcher`
 * function are the frozen contract consumed by `handle-turn.ts` and tests.
 */

import { NameResolver } from '../name-resolver.js';
import { DISPATCH_CLOUD_AGENT_DESCRIPTOR, handleDispatchCloudAgent } from './cloud-agent.js';
import {
  handleSetPlan,
  handleUpdateTask,
  SET_PLAN_DESCRIPTOR,
  UPDATE_TASK_DESCRIPTOR,
} from './planning.js';
import {
  handlePresentCard,
  handlePresentTable,
  PRESENT_CARD_DESCRIPTOR,
  PRESENT_TABLE_DESCRIPTOR,
} from './presentation.js';
import {
  handleReadChannel,
  handleReadThread,
  handleListChannels,
  READ_CHANNEL_DESCRIPTOR,
  READ_THREAD_DESCRIPTOR,
  LIST_CHANNELS_DESCRIPTOR,
} from './slack-read.js';
import { handleSearchMessages, SEARCH_MESSAGES_DESCRIPTOR } from './slack-search.js';
import {
  handleReadUserProfile,
  handleSetStatus,
  handleAddReminder,
  READ_USER_PROFILE_DESCRIPTOR,
  SET_STATUS_DESCRIPTOR,
  ADD_REMINDER_DESCRIPTOR,
} from './slack-users.js';
import {
  handlePostAsOwner,
  handleReactAsOwner,
  handleDeleteMessage,
  POST_AS_OWNER_DESCRIPTOR,
  REACT_AS_OWNER_DESCRIPTOR,
  DELETE_MESSAGE_DESCRIPTOR,
} from './slack-write.js';
import { handleGetCurrentTime, GET_CURRENT_TIME_DESCRIPTOR } from './time.js';
import {
  handleFetchUrl,
  handleWebSearch,
  handleRunCli,
  FETCH_URL_DESCRIPTOR,
  WEB_SEARCH_DESCRIPTOR,
  RUN_CLI_DESCRIPTOR,
} from './web.js';

import type { PlanController } from '../plan-controller.js';
import type { SlackClient } from '@sym/adapter-slack';
import type {
  SlackChannelId,
  SlackThreadTs,
  SlackUserId,
  ToolCall,
  ToolDescriptor,
  ToolDispatcher,
  ToolResult,
  ToolRuntimeContext,
} from '@sym/contracts';
import type { CloudRunStore, CursorCloudClient, RepoAllowlist } from '@sym/cursor-runtime';

/**
 * Dependencies required by the built-in dispatcher.
 *
 * `slackClient` is the bot-token client (Sym's identity). `userSlackClient` is
 * the optional owner-token client. Per-tool actor routing picks one or the
 * other; READ tools that prefer user fall back to bot when the user token
 * isn't configured.
 */
export interface BuiltinToolDeps {
  slackClient: SlackClient;
  /** Owner user-token client; set when SLACK_OWNER_USER_TOKEN is configured. */
  userSlackClient?: SlackClient;
  botUserId: SlackUserId;
  /**
   * When true, `post_as_owner` appends a `_(via Sym)_` footer to the posted
   * message so collaborators can tell the owner used an assistant to relay it.
   * Driven by `BehaviorConfig.ownerPostMarker`.
   */
  ownerPostMarker?: boolean;
  /**
   * Per-turn plan controller backing the `set_plan` / `update_task` tools.
   * Optional: when absent (e.g. tests, non-streaming surfaces) those tools
   * fail cleanly with `execution_failed`. The streaming reply path always
   * supplies one.
   */
  planController?: PlanController;
  /**
   * Workspace-scoped name resolver shared across all turns. Used to rewrite
   * `<@U…>` / `<#C…>` markup in tool returns BEFORE the model sees it, so
   * raw ids can't leak into replies. Optional only for legacy test paths;
   * production always supplies one (constructed in `loadWorkspaceContext`).
   * When absent, tool returns include raw ids — degraded but functional.
   */
  nameResolver?: NameResolver;
  /**
   * Cursor cloud-agent deps for THIS turn. Present only when the feature is
   * configured (CURSOR_API_KEY) AND the turn has a postable thread. Its presence
   * is what conditionally registers `dispatch_cloud_agent` below — the static
   * descriptor list cannot vary by config, so gating lives on the per-instance
   * dispatcher. `confirm` drives the descriptor's `destructiveHint` so the
   * confirmation gate can be opted out via SYM_CLOUD_AGENT_CONFIRM=false.
   */
  cursor?: {
    client: CursorCloudClient;
    store: CloudRunStore;
    allowlist: RepoAllowlist;
    channel: SlackChannelId;
    threadTs: SlackThreadTs;
    confirm: boolean;
  };
}

/** Ordered list of all built-in tool descriptors. */
const ALL_BUILTIN_DESCRIPTORS: ToolDescriptor[] = [
  GET_CURRENT_TIME_DESCRIPTOR,
  READ_CHANNEL_DESCRIPTOR,
  READ_THREAD_DESCRIPTOR,
  READ_USER_PROFILE_DESCRIPTOR,
  FETCH_URL_DESCRIPTOR,
  WEB_SEARCH_DESCRIPTOR,
  RUN_CLI_DESCRIPTOR,
  LIST_CHANNELS_DESCRIPTOR,
  SEARCH_MESSAGES_DESCRIPTOR,
  POST_AS_OWNER_DESCRIPTOR,
  REACT_AS_OWNER_DESCRIPTOR,
  SET_STATUS_DESCRIPTOR,
  ADD_REMINDER_DESCRIPTOR,
  DELETE_MESSAGE_DESCRIPTOR,
  SET_PLAN_DESCRIPTOR,
  UPDATE_TASK_DESCRIPTOR,
  PRESENT_CARD_DESCRIPTOR,
  PRESENT_TABLE_DESCRIPTOR,
];

const DESCRIPTORS_BY_NAME = new Map<string, ToolDescriptor>(
  ALL_BUILTIN_DESCRIPTORS.map((d) => [d.name, d]),
);

/**
 * Pick the Slack client appropriate for this descriptor's `actor`.
 *
 * `actor: 'user'`:
 *  - user client present → use it
 *  - user client missing AND tool is read-only / non-destructive → fall back
 *    to the bot client (it'll still work, just with bot's narrower visibility)
 *  - user client missing AND tool is destructive → return null so the
 *    dispatcher emits an "unavailable" error (we will not silently post-as-
 *    Sym when the model asked for post-as-owner)
 *
 * `actor: 'bot'` or unset → always the bot client.
 */
function pickClient(
  descriptor: ToolDescriptor,
  deps: BuiltinToolDeps,
): { client: SlackClient; usedActor: 'bot' | 'user' } | null {
  if (descriptor.actor === 'user') {
    if (deps.userSlackClient !== undefined) {
      return { client: deps.userSlackClient, usedActor: 'user' };
    }
    if (descriptor.destructiveHint === true) {
      return null; // hard-required user token is missing
    }
    return { client: deps.slackClient, usedActor: 'bot' };
  }
  return { client: deps.slackClient, usedActor: 'bot' };
}

/**
 * Create the built-in in-process tool dispatcher.
 *
 * The Map-based dispatch table replaces the original 866-line if/else chain.
 * Each handler is a thin async function that receives only what it needs;
 * the registry closure captures the per-turn search cache + resolver.
 *
 * External signature is identical to the original `createBuiltinDispatcher`
 * — this refactor is invisible to `handle-turn.ts` and all tests.
 */
export function createBuiltinDispatcher(deps: BuiltinToolDeps): ToolDispatcher {
  // Workspace-scoped name resolver — preferred. Falls back to an ad-hoc
  // per-dispatcher resolver if deps.nameResolver wasn't supplied (legacy
  // test paths). Either way the same code paths apply; production always
  // wires the shared one via `loadWorkspaceContext` for cross-turn reuse.
  const resolver = deps.nameResolver ?? new NameResolver();

  // Per-turn search dedup. The model sometimes re-runs the IDENTICAL query
  // several times in one turn — each costs ~400ms and re-bloats the context,
  // pushing the turn toward a request timeout. This dispatcher lives for one
  // turn, so caching by exact (query+sort+limit) is safe: results can't
  // meaningfully change mid-turn. Cached on success only.
  const searchCache = new Map<string, ToolResult>();

  // Map-based dispatch: ~10-line lookup replaces 866-line if/else chain.
  type Handler = (
    call: ToolCall,
    slack: SlackClient,
    usedActor: 'bot' | 'user',
  ) => Promise<ToolResult>;
  const handlers = new Map<string, Handler>([
    ['get_current_time', (call) => Promise.resolve(handleGetCurrentTime(call))],
    ['read_channel', (call, slack) => handleReadChannel(call, slack, deps.botUserId, resolver)],
    ['read_thread', (call, slack) => handleReadThread(call, slack, deps.botUserId, resolver)],
    ['read_user_profile', (call, slack) => handleReadUserProfile(call, slack, resolver)],
    ['fetch_url', (call) => handleFetchUrl(call)],
    ['web_search', (call) => handleWebSearch(call)],
    ['run_cli', (call) => handleRunCli(call)],
    [
      'list_channels',
      (call, slack, usedActor) => handleListChannels(call, slack, usedActor, resolver),
    ],
    [
      'search_messages',
      (call, slack, usedActor) =>
        handleSearchMessages(call, slack, usedActor, resolver, searchCache),
    ],
    ['post_as_owner', (call, slack) => handlePostAsOwner(call, slack, deps.ownerPostMarker)],
    ['react_as_owner', (call, slack) => handleReactAsOwner(call, slack)],
    ['set_status', (call, slack) => handleSetStatus(call, slack)],
    ['add_reminder', (call, slack) => handleAddReminder(call, slack)],
    ['delete_message', (call, slack) => handleDeleteMessage(call, slack)],
    ['set_plan', (call) => handleSetPlan(call, deps.planController)],
    ['update_task', (call) => handleUpdateTask(call, deps.planController)],
    ['present_card', (call) => Promise.resolve(handlePresentCard(call))],
    ['present_table', (call) => Promise.resolve(handlePresentTable(call))],
  ]);

  // Conditional registration: `dispatch_cloud_agent` exists only when this turn
  // carries cursor deps. The descriptor list + lookup map are built PER INSTANCE
  // (not from the module-level const, which cannot vary by config). `confirm`
  // drives `destructiveHint` so SYM_CLOUD_AGENT_CONFIRM=false skips the gate.
  const cursor = deps.cursor;
  const descriptors = cursor
    ? [
        ...ALL_BUILTIN_DESCRIPTORS,
        { ...DISPATCH_CLOUD_AGENT_DESCRIPTOR, destructiveHint: cursor.confirm },
      ]
    : ALL_BUILTIN_DESCRIPTORS;
  const descriptorsByName = cursor
    ? new Map<string, ToolDescriptor>(descriptors.map((d) => [d.name, d]))
    : DESCRIPTORS_BY_NAME;
  if (cursor) {
    handlers.set('dispatch_cloud_agent', (call) =>
      handleDispatchCloudAgent(call, {
        client: cursor.client,
        store: cursor.store,
        allowlist: cursor.allowlist,
        slackClient: deps.slackClient,
        channel: cursor.channel,
        threadTs: cursor.threadTs,
      }),
    );
  }

  return {
    list(): ToolDescriptor[] {
      return descriptors;
    },

    async dispatch(call: ToolCall, _ctx: ToolRuntimeContext): Promise<ToolResult> {
      const descriptor = descriptorsByName.get(call.name);
      const pick = descriptor
        ? pickClient(descriptor, deps)
        : { client: deps.slackClient, usedActor: 'bot' as const };

      if (pick === null) {
        return {
          callId: call.id,
          ok: false,
          error: {
            code: 'execution_failed',
            message: `${call.name} requires the owner user token (SLACK_OWNER_USER_TOKEN). Not configured on this deployment.`,
          },
        };
      }

      const handler = handlers.get(call.name);
      if (handler === undefined) {
        return {
          callId: call.id,
          ok: false,
          error: { code: 'not_found', message: `Unknown tool: ${call.name}` },
        };
      }

      return handler(call, pick.client, pick.usedActor);
    },
  };
}
