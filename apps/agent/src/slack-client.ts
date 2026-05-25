import type {
  ConversationsRepliesParams,
  ConversationsRepliesResult,
  PostMessageParams,
  PostMessageResult,
  ReactionsAddParams,
  SetStatusParams,
  SlackApiError,
  SlackClient,
  SlackThreadMessage,
  UpdateMessageParams,
} from '@sym/adapter-slack';
import type { SlackChannelId, SlackThreadTs, SlackUserId } from '@sym/contracts';

const SLACK_API = 'https://slack.com/api';

/** Slack's max page size for conversations.replies. */
const SLACK_PAGE_LIMIT = 200;
/** Default ceiling on messages fetched across pagination for one thread. */
const THREAD_FETCH_CEILING = 200;

/** Error matching the adapter's `SlackApiError` shape so `withSlackRetries` can read it. */
class SlackWebApiError extends Error implements SlackApiError {
  readonly code: string;
  readonly data: { error?: string; retry_after?: number };
  constructor(code: string, data: { error?: string; retry_after?: number } = {}) {
    super(code);
    this.name = 'SlackWebApiError';
    this.code = code;
    this.data = data;
  }
}

interface SlackOkResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

/** Raw `conversations.replies` payload — only the fields the mapper reads. */
interface RepliesResponse extends SlackOkResponse {
  messages?: {
    user?: string;
    bot_id?: string;
    text?: string;
    ts?: string;
    subtype?: string;
  }[];
  response_metadata?: { next_cursor?: string };
}

/**
 * Concrete `SlackClient` over the Slack Web API, authed with a workspace bot
 * token. The adapter package owns the typed interface; this is the real impl
 * the agent wires in (tests inject a mock instead).
 */
export class WebApiSlackClient implements SlackClient {
  constructor(private readonly botToken: string) {}

  private async call<T extends SlackOkResponse = SlackOkResponse>(
    method: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '1');
      throw new SlackWebApiError('ratelimited', { error: 'ratelimited', retry_after: retryAfter });
    }

    const json = (await res.json()) as T;
    if (!json.ok) {
      const errorCode = json.error ?? 'unknown_error';
      throw new SlackWebApiError(errorCode, { error: errorCode });
    }
    return json;
  }

  async chatPostMessage(params: PostMessageParams): Promise<PostMessageResult> {
    const json = await this.call('chat.postMessage', {
      channel: params.channel,
      text: params.text,
      ...(params.blocks !== undefined ? { blocks: params.blocks } : {}),
      ...(params.thread_ts !== undefined ? { thread_ts: params.thread_ts } : {}),
    });
    return {
      ts: (json.ts ?? '') as SlackThreadTs,
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
      const json = await this.call<RepliesResponse>('conversations.replies', {
        channel: params.channel,
        ts: params.ts,
        limit: Math.min(SLACK_PAGE_LIMIT, ceiling - messages.length),
        ...(cursor !== undefined ? { cursor } : {}),
      });

      for (const m of json.messages ?? []) {
        messages.push({
          ...(m.user !== undefined ? { user: m.user as SlackUserId } : {}),
          ...(m.bot_id !== undefined ? { botId: m.bot_id } : {}),
          text: m.text ?? '',
          ts: (m.ts ?? '') as SlackThreadTs,
          ...(m.subtype !== undefined ? { subtype: m.subtype } : {}),
        });
      }

      cursor = json.response_metadata?.next_cursor || undefined;
    } while (cursor !== undefined && messages.length < ceiling);

    return { messages };
  }
}
