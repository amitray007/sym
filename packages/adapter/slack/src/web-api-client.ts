import { SlackWebApiError, withSlackRetries } from './retry.js';
import { mapChannelSummary, mapMessageRow, mapUserProfile } from './web-api-mappers.js';

import type { SlackClient } from './client.js';
import type {
  AppendStreamParams,
  AuthTestResult,
  ConversationsHistoryParams,
  ConversationsHistoryResult,
  ConversationsInfoParams,
  ConversationsInfoResult,
  ConversationsListParams,
  ConversationsListResult,
  ConversationsRepliesParams,
  ConversationsRepliesResult,
  DeleteMessageParams,
  PostMessageParams,
  PostMessageResult,
  ReactionsAddParams,
  RemindersAddParams,
  RemindersAddResult,
  SearchMessageMatch,
  SearchMessagesParams,
  SearchMessagesResult,
  SetStatusParams,
  SetSuggestedPromptsParams,
  SetTitleParams,
  SlackChannelSummary,
  SlackThreadMessage,
  SlackUserProfile,
  StartStreamParams,
  StopStreamParams,
  StreamHandle,
  UpdateMessageParams,
  UsersInfoParams,
  UsersListParams,
  UsersListResult,
  UsersProfileSetParams,
} from './types.js';
import type { SlackPagedResponse, SlackRawChannel, SlackRawUser } from './web-api-mappers.js';
import type { SlackChannelId, SlackThreadTs, SlackUserId } from '@sym/contracts';

const SLACK_API = 'https://slack.com/api';

/** Slack's max page size for conversations.replies. */
const SLACK_PAGE_LIMIT = 200;
/** Default ceiling on messages fetched across pagination for one thread. */
const THREAD_FETCH_CEILING = 200;
/** Default ceiling on channel history messages for viewed-channel context. */
const CHANNEL_HISTORY_CEILING = 30;

interface SlackOkResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

/**
 * Concrete `SlackClient` over the Slack Web API, authed with a workspace bot
 * token. Lives in the adapter package alongside the interface it implements.
 * Tests inject a mock instead.
 */
export class WebApiSlackClient implements SlackClient {
  constructor(private readonly botToken: string) {}

  /**
   * Shared transport: POST to a Slack method. Wrapped in the retry layer so
   * EVERY call (read + write) automatically backs off on 429 — no per-method
   * opt-in. Terminal Slack errors surface as a `SlackError` (an `Error` that
   * also carries the structured `SlackActionError` fields).
   */
  private dispatch<T extends SlackOkResponse = SlackOkResponse>(
    method: string,
    contentType: string,
    body: string,
  ): Promise<T> {
    return withSlackRetries(async () => {
      const res = await fetch(`${SLACK_API}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.botToken}`,
          'content-type': contentType,
        },
        body,
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '1');
        throw new SlackWebApiError('ratelimited', {
          error: 'ratelimited',
          retry_after: retryAfter,
        });
      }

      const json = (await res.json()) as T;
      if (!json.ok) {
        const errorCode = json.error ?? 'unknown_error';
        throw new SlackWebApiError(errorCode, { error: errorCode });
      }
      return json;
    });
  }

  /** JSON-body call — for write methods (chat.*, assistant.*) that accept it. */
  private call<T extends SlackOkResponse = SlackOkResponse>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    return this.dispatch<T>(method, 'application/json; charset=utf-8', JSON.stringify(body));
  }

  /**
   * Form-urlencoded call — for read methods. Slack's `conversations.*` read
   * methods reject `application/json` with `invalid_arguments`, so their
   * (simple, scalar) params must be sent as a urlencoded form.
   */
  private callForm<T extends SlackOkResponse = SlackOkResponse>(
    method: string,
    params: Record<string, string | number | undefined>,
  ): Promise<T> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) form.set(key, String(value));
    }
    return this.dispatch<T>(
      method,
      'application/x-www-form-urlencoded; charset=utf-8',
      form.toString(),
    );
  }

  async chatPostMessage(params: PostMessageParams): Promise<PostMessageResult> {
    const json = await this.call('chat.postMessage', {
      channel: params.channel,
      text: params.text,
      ...(params.blocks !== undefined ? { blocks: params.blocks } : {}),
      ...(params.thread_ts !== undefined ? { thread_ts: params.thread_ts } : {}),
    });
    const ts = json.ts;
    if (!ts) throw new SlackWebApiError('missing_ts', { error: 'missing_ts' });
    return {
      ts: ts as SlackThreadTs,
      channel: (json.channel ?? params.channel) as SlackChannelId,
    };
  }

  async chatUpdate(params: UpdateMessageParams): Promise<void> {
    await this.call('chat.update', {
      channel: params.channel,
      ts: params.ts,
      text: params.text,
      ...(params.blocks !== undefined ? { blocks: params.blocks } : {}),
    });
  }

  async chatDelete(params: DeleteMessageParams): Promise<void> {
    await this.call('chat.delete', {
      channel: params.channel,
      ts: params.ts,
    });
  }

  async reactionsAdd(params: ReactionsAddParams): Promise<void> {
    await this.call('reactions.add', {
      channel: params.channel,
      timestamp: params.timestamp,
      name: params.name,
    });
  }

  async assistantThreadsSetStatus(params: SetStatusParams): Promise<void> {
    await this.call('assistant.threads.setStatus', {
      channel_id: params.channelId,
      thread_ts: params.threadTs,
      status: params.status,
      ...(params.loadingMessages !== undefined && params.loadingMessages.length > 0
        ? { loading_messages: params.loadingMessages.slice(0, 10) }
        : {}),
    });
  }

  async conversationsReplies(
    params: ConversationsRepliesParams,
  ): Promise<ConversationsRepliesResult> {
    const ceiling = params.limit ?? THREAD_FETCH_CEILING;
    const messages: SlackThreadMessage[] = [];
    let cursor: string | undefined;

    // Page through the thread (Slack caps a page at SLACK_PAGE_LIMIT) until we
    // run out of replies or hit the ceiling — whichever comes first.
    do {
      const json = await this.callForm<SlackPagedResponse>('conversations.replies', {
        channel: params.channel,
        ts: params.ts,
        limit: Math.min(SLACK_PAGE_LIMIT, ceiling - messages.length),
        ...(cursor !== undefined ? { cursor } : {}),
      });

      for (const m of json.messages ?? []) messages.push(mapMessageRow(m));
      cursor = json.response_metadata?.next_cursor || undefined;
    } while (cursor !== undefined && messages.length < ceiling);

    return { messages };
  }

  async conversationsHistory(
    params: ConversationsHistoryParams,
  ): Promise<ConversationsHistoryResult> {
    const ceiling = params.limit ?? CHANNEL_HISTORY_CEILING;
    const collected: SlackThreadMessage[] = [];
    let cursor: string | undefined;

    // Page through the channel (Slack returns newest-first) until we hit the
    // ceiling or run out of messages — whichever comes first.
    do {
      const json = await this.callForm<SlackPagedResponse>('conversations.history', {
        channel: params.channel,
        limit: Math.min(SLACK_PAGE_LIMIT, ceiling - collected.length),
        ...(cursor !== undefined ? { cursor } : {}),
      });

      for (const m of json.messages ?? []) collected.push(mapMessageRow(m));
      cursor = json.response_metadata?.next_cursor || undefined;
    } while (cursor !== undefined && collected.length < ceiling);

    // Slack returns newest-first; reverse to chronological (oldest-first).
    collected.reverse();
    return { messages: collected };
  }

  async assistantThreadsSetSuggestedPrompts(params: SetSuggestedPromptsParams): Promise<void> {
    await this.call('assistant.threads.setSuggestedPrompts', {
      channel_id: params.channelId,
      thread_ts: params.threadTs,
      prompts: params.prompts,
      ...(params.title !== undefined ? { title: params.title } : {}),
    });
  }

  async assistantThreadsSetTitle(params: SetTitleParams): Promise<void> {
    await this.call('assistant.threads.setTitle', {
      channel_id: params.channelId,
      thread_ts: params.threadTs,
      title: params.title,
    });
  }

  async chatStartStream(params: StartStreamParams): Promise<StreamHandle> {
    const json = await this.call('chat.startStream', {
      channel: params.channel,
      thread_ts: params.threadTs,
      ...(params.recipientUserId !== undefined
        ? { recipient_user_id: params.recipientUserId }
        : {}),
      ...(params.recipientTeamId !== undefined
        ? { recipient_team_id: params.recipientTeamId }
        : {}),
      ...(params.markdownText !== undefined ? { markdown_text: params.markdownText } : {}),
      ...(params.taskDisplayMode !== undefined
        ? { task_display_mode: params.taskDisplayMode }
        : {}),
    });
    return {
      channel: (json.channel ?? params.channel) as SlackChannelId,
      ts: (json.ts ?? '') as SlackThreadTs,
    };
  }

  async chatAppendStream(params: AppendStreamParams): Promise<void> {
    // Normalise both inputs into one `chunks` array. Slack drops the
    // top-level `markdown_text` param when interleaved with chunk calls in
    // the same stream, so we always send via `chunks`.
    const chunks = [...(params.chunks ?? [])];
    if (params.markdownText !== undefined && params.markdownText.length > 0) {
      chunks.unshift({ type: 'markdown_text', text: params.markdownText });
    }
    if (chunks.length === 0) return;
    await this.call('chat.appendStream', {
      channel: params.channel,
      ts: params.ts,
      chunks,
    });
  }

  async chatStopStream(params: StopStreamParams): Promise<void> {
    await this.call('chat.stopStream', {
      channel: params.channel,
      ts: params.ts,
      ...(params.blocks !== undefined ? { blocks: params.blocks } : {}),
    });
  }

  async usersInfo(params: UsersInfoParams): Promise<SlackUserProfile> {
    interface UserResponse extends SlackOkResponse {
      user?: SlackRawUser;
    }
    const json = await this.callForm<UserResponse>('users.info', { user: params.user });
    const u = json.user ?? {};
    const id = u.id;
    if (!id) throw new SlackWebApiError('missing_user_id', { error: 'missing_user_id' });
    return mapUserProfile({ ...u, id });
  }

  async usersList(params: UsersListParams): Promise<UsersListResult> {
    interface UsersListResponse extends SlackOkResponse {
      members?: SlackRawUser[];
      response_metadata?: { next_cursor?: string };
    }
    // Page through users.list (Slack caps a single page at 200) until the
    // caller's ceiling or the workspace runs out. Large workspaces have
    // thousands of members; the ceiling keeps boot bounded.
    const ceiling = params.limit ?? 2000;
    const members: SlackRawUser[] = [];
    let cursor: string | undefined;
    do {
      const json = await this.callForm<UsersListResponse>('users.list', {
        limit: Math.min(SLACK_PAGE_LIMIT, ceiling - members.length),
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const m of json.members ?? []) members.push(m);
      cursor = json.response_metadata?.next_cursor || undefined;
    } while (cursor !== undefined && members.length < ceiling);

    // Filter out members with no id — Slack should always return one, but
    // guard against emitting empty branded ids.
    const users: SlackUserProfile[] = members
      .filter(
        (u): u is SlackRawUser & { id: string } => typeof u.id === 'string' && u.id.length > 0,
      )
      .map(mapUserProfile);
    return { users };
  }

  async conversationsInfo(params: ConversationsInfoParams): Promise<ConversationsInfoResult> {
    // conversations.info returns `channel` as the conversation OBJECT, which
    // collides with SlackOkResponse's `channel?: string`. Fetch with the base
    // type, then narrow the payload via a cast.
    interface InfoChannel {
      id?: string;
      name?: string;
      is_im?: boolean;
      is_mpim?: boolean;
      /** On an `im`, Slack returns the OTHER participant's user id here. */
      user?: string;
    }
    const json = (await this.callForm('conversations.info', {
      channel: params.channel,
    })) as { channel?: InfoChannel };
    const c = json.channel ?? {};
    const id = c.id;
    if (!id) throw new SlackWebApiError('missing_channel_id', { error: 'missing_channel_id' });
    return {
      id: id as SlackChannelId,
      isIm: c.is_im === true,
      isMpim: c.is_mpim === true,
      ...(c.user !== undefined && c.user !== '' ? { userId: c.user as SlackUserId } : {}),
      ...(c.name !== undefined && c.name !== '' ? { name: c.name } : {}),
    };
  }

  async authTest(): Promise<AuthTestResult> {
    interface AuthTestResponse extends SlackOkResponse {
      user_id?: string;
      team_id?: string;
      user?: string;
      bot_id?: string;
    }
    const json = await this.call<AuthTestResponse>('auth.test', {});
    const userId = json.user_id;
    if (!userId) throw new SlackWebApiError('missing_user_id', { error: 'missing_user_id' });
    return {
      userId: userId as SlackUserId,
      teamId: json.team_id ?? '',
      ...(json.user !== undefined ? { user: json.user } : {}),
      ...(json.bot_id !== undefined ? { isBot: true } : {}),
    };
  }

  async searchMessages(params: SearchMessagesParams): Promise<SearchMessagesResult> {
    interface SearchResponse extends SlackOkResponse {
      messages?: {
        total?: number;
        matches?: {
          channel?: { id?: string; name?: string };
          username?: string;
          user?: string;
          ts?: string;
          text?: string;
          permalink?: string;
        }[];
      };
    }
    // search.messages is a classic Web API: form-urlencoded.
    const json = await this.callForm<SearchResponse>('search.messages', {
      query: params.query,
      sort: params.sort ?? 'score',
      sort_dir: params.sortDir ?? 'desc',
      count: params.count ?? 20,
      ...(params.page !== undefined ? { page: params.page } : {}),
    });
    const raw = json.messages?.matches ?? [];
    // Filter out matches with no channel id — guard against empty branded ids.
    const matches: SearchMessageMatch[] = raw
      .filter(
        (m): m is (typeof raw)[number] & { channel: { id: string } } =>
          typeof m.channel?.id === 'string' && m.channel.id.length > 0,
      )
      .map((m) => ({
        channelId: m.channel.id as SlackChannelId,
        ...(m.channel.name !== undefined ? { channelName: m.channel.name } : {}),
        ...(m.username !== undefined ? { username: m.username } : {}),
        ...(m.user !== undefined ? { userId: m.user as SlackUserId } : {}),
        ts: (m.ts ?? '') as SlackThreadTs,
        text: m.text ?? '',
        ...(m.permalink !== undefined ? { permalink: m.permalink } : {}),
      }));
    return { matches, total: json.messages?.total ?? matches.length };
  }

  async usersProfileSet(params: UsersProfileSetParams): Promise<void> {
    // Slack expects the profile fields nested under `profile` as a JSON object.
    const profile: Record<string, unknown> = {
      status_text: params.statusText,
    };
    if (params.statusEmoji !== undefined) profile['status_emoji'] = params.statusEmoji;
    if (params.statusExpiration !== undefined) {
      profile['status_expiration'] = params.statusExpiration;
    }
    await this.call('users.profile.set', { profile });
  }

  async remindersAdd(params: RemindersAddParams): Promise<RemindersAddResult> {
    interface RemindersResponse extends SlackOkResponse {
      reminder?: {
        id?: string;
        text?: string;
        time?: number;
      };
    }
    const json = await this.call<RemindersResponse>('reminders.add', {
      text: params.text,
      time: params.time,
    });
    return {
      id: json.reminder?.id ?? '',
      text: json.reminder?.text ?? params.text,
      ...(json.reminder?.time !== undefined ? { time: json.reminder.time } : {}),
    };
  }

  async conversationsList(params: ConversationsListParams): Promise<ConversationsListResult> {
    interface ListResponse extends SlackOkResponse {
      channels?: SlackRawChannel[];
      response_metadata?: { next_cursor?: string };
    }
    // Page through conversations.list (Slack caps a single page at 200) until
    // we hit the caller's ceiling or run out of channels. Without pagination,
    // owners in 50+ channels silently miss the rest of their workspace.
    const ceiling = params.limit ?? 200;
    const collected: SlackRawChannel[] = [];
    let cursor: string | undefined;
    do {
      const json = await this.callForm<ListResponse>('conversations.list', {
        limit: Math.min(SLACK_PAGE_LIMIT, ceiling - collected.length),
        types: params.types ?? 'public_channel,private_channel',
        exclude_archived: params.excludeArchived === false ? 'false' : 'true',
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const c of json.channels ?? []) collected.push(c);
      cursor = json.response_metadata?.next_cursor || undefined;
    } while (cursor !== undefined && collected.length < ceiling);

    // Filter out channels with no id — guard against empty branded ids.
    const channels: SlackChannelSummary[] = collected
      .filter(
        (c): c is SlackRawChannel & { id: string } => typeof c.id === 'string' && c.id.length > 0,
      )
      .map(mapChannelSummary);
    return { channels };
  }
}
