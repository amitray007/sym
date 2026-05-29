/**
 * Workspace-scoped name resolver — converts raw Slack ids into display names
 * BEFORE the model ever sees them.
 *
 * **Problem this solves.** Slack messages, search results, and channel
 * histories arrive with raw `<@U042…>` and `<#C0ABC|name>` markup. Today the
 * system prompt asks the model not to echo those ids — but prompts only get
 * us partway. The real fix is structural: rewrite ids → names in tool
 * returns, so the model has nothing raw to leak.
 *
 * **Two stores, two fill strategies.**
 *  - **Users**: lazy. No bulk `users.list` in the adapter today (would need a
 *    contract addition). On cache miss we hit `users.info` once and remember
 *    the result. Failures stick (`null`) so we don't retry the same 404.
 *  - **Channels**: eager. The adapter has `conversations.list`, so we bulk
 *    fetch at boot (best-effort, fire-and-forget). Public + private the bot
 *    can see. Lazy fallback for any id the bulk fetch missed.
 *
 * **Lifecycle.** One resolver per agent process. Survives across turns.
 * Concurrent boot fills are coalesced via a single promise so racing turns
 * don't trigger duplicate `conversations.list` calls.
 *
 * **What we DON'T do.**
 *  - No TTL / expiry. Display names rarely change; if they do, restart the
 *    agent or pay the next lookup. Premature complexity otherwise.
 *  - No write path. Mentions the model wants to emit ("ping Sarah") still
 *    go through `read_user_profile` or `search_messages` — by design, the
 *    resolver is a READ-side concern.
 */

import type { SlackClient } from '@sym/adapter-slack';
import type { SlackChannelId, SlackUserId } from '@sym/contracts';

/** `null` means we tried and failed — sticky so we don't re-fetch on every read. */
type CacheValue = string | null;

/** Match `<@U…>` and `<@W…>` Slack mention syntax (workspace/external members). */
const USER_MENTION_RE = /<@([UW][A-Z0-9]+)>/g;
/**
 * Match Slack channel-link syntax `<#XXX|optional-name>` for any uppercase
 * id prefix. Public channels are `C…`, DMs are `D…`, MPIMs `G…`, but Slack
 * search occasionally returns DMs with `<#U…|direct message>` style markup
 * where the id is the OTHER party's user id. We accept any uppercase id
 * shape and rely on (a) the channel cache for normal `C…` ids, (b) the
 * inline label as fallback for the weird shapes. Without this widening the
 * raw `<#U03…|direct message>` markup leaked into search-result replies.
 */
const CHANNEL_MENTION_RE = /<#([A-Z][A-Z0-9]+)(?:\|([^>]*))?>/g;

export class NameResolver {
  private readonly users = new Map<string, CacheValue>();
  private readonly channels = new Map<string, CacheValue>();
  private channelBulkFill: Promise<void> | null = null;
  private channelBulkFillStarted = false;

  /**
   * Synchronous accessor — returns a cached display name or `undefined` if
   * the id is unknown. Useful for hot paths where you don't want to pay an
   * API call. Treats sticky `null` as "unknown" too.
   */
  getUser(id: string): string | undefined {
    const v = this.users.get(id);
    return v ?? undefined;
  }

  /** Synchronous channel-name accessor. Same `null`-as-undefined semantics. */
  getChannel(id: string): string | undefined {
    const v = this.channels.get(id);
    return v ?? undefined;
  }

  /**
   * Resolve a single user id to a display name, hitting `users.info` on
   * cache miss. Failure is cached as `null` and surfaces as the raw id
   * fallback (callers receive the input id back). Safe to call concurrently
   * on the same id — duplicate API calls aren't deduped (rare race, cheap
   * cost; the second writer just overwrites with the same value).
   */
  async resolveUser(id: string, slack: SlackClient): Promise<string> {
    if (this.users.has(id)) {
      return this.users.get(id) ?? id;
    }
    try {
      const p = await slack.usersInfo({ user: id as SlackUserId });
      const name = p.displayName ?? p.realName ?? p.userName ?? null;
      this.users.set(id, name);
      return name ?? id;
    } catch {
      this.users.set(id, null);
      return id;
    }
  }

  /**
   * Resolve a single channel id. Channels don't have a 1-by-1 lookup in the
   * adapter today, so on miss we kick off (or join) the bulk fill. If the
   * id is still missing after bulk fill (e.g. archived, or the bot can't
   * see it), the raw id is returned.
   */
  async resolveChannel(id: string, slack: SlackClient): Promise<string> {
    const hit = this.channels.get(id);
    if (hit !== undefined) return hit ?? id;
    await this.ensureChannelsBulkFilled(slack);
    const after = this.channels.get(id);
    if (after !== undefined) return after ?? id;
    // Bulk fill did NOT include this channel — record sticky miss and fall back.
    this.channels.set(id, null);
    return id;
  }

  /**
   * Rewrite every `<@U…>` and `<#C…|name>` in `text` to `@DisplayName` and
   * `#channel-name`. Unknown ids are resolved on demand (parallel API calls
   * across distinct ids). When resolution fails, the original markup is
   * left intact so the model can still see *something* — better than a
   * silent drop.
   *
   * Used on every tool return that surfaces Slack text to the model.
   */
  async rewriteMentions(text: string, slack: SlackClient): Promise<string> {
    if (text.length === 0) return text;

    // Collect unique unknown ids in one pass so concurrent resolves run in parallel.
    const userIds = new Set<string>();
    const channelIds = new Set<string>();
    for (const m of text.matchAll(USER_MENTION_RE)) {
      const id = m[1]!;
      if (!this.users.has(id)) userIds.add(id);
    }
    for (const m of text.matchAll(CHANNEL_MENTION_RE)) {
      const id = m[1]!;
      if (id.startsWith('C')) {
        // Canonical public/private channel id — resolve via the channel cache.
        if (!this.channels.has(id)) channelIds.add(id);
      } else if ((id.startsWith('U') || id.startsWith('W')) && !this.users.has(id)) {
        // DM-style channel markup (`<#U…|direct message>`, or a bare `<#U…>`)
        // carries the OTHER party's USER id, not a channel id. Resolve it as a
        // USER so the DM renders as the person's name instead of leaking `U…`.
        userIds.add(id);
      }
      // D… (DM) / G… (MPIM) channel ids: no 1-by-1 lookup; handled by the
      // inline label or a generic fallback in the replace pass below.
    }

    await Promise.all([
      ...[...userIds].map((id) => this.resolveUser(id, slack)),
      ...[...channelIds].map((id) => this.resolveChannel(id, slack)),
    ]);

    return text
      .replace(USER_MENTION_RE, (match, id: string) => {
        const name = this.users.get(id);
        return name != null ? `@${name}` : match;
      })
      .replace(CHANNEL_MENTION_RE, (match, id: string, inlineName?: string) =>
        this.renderChannelMention(match, id, inlineName),
      );
  }

  /**
   * Render a `<#…|label>` channel-mention to display text. A `U…`/`W…` id is a
   * DM (the markup carries the other party's USER id) — render the person, and
   * NEVER fall back to the raw id (the model would print `#U03… (DM)`). A `C…`
   * id renders as `#name`; an unresolved channel keeps its inline label or the
   * original markup as last resort.
   */
  private renderChannelMention(match: string, id: string, inlineName?: string): string {
    if (id.startsWith('U') || id.startsWith('W')) {
      const uname = this.users.get(id);
      if (uname != null) return `@${uname}`;
      if (inlineName != null && inlineName.length > 0) return inlineName;
      return 'a direct message';
    }
    const name = this.channels.get(id) ?? inlineName;
    return name != null && name.length > 0 ? `#${name}` : match;
  }

  /**
   * Best-effort boot-time bulk fill of channels (public + private the bot
   * can see). Fire-and-forget from the caller — failures log a warning and
   * leave the resolver in lazy mode. Idempotent: subsequent calls are no-ops.
   */
  async populateChannels(slack: SlackClient): Promise<void> {
    await this.ensureChannelsBulkFilled(slack);
  }

  /** Internal — coalesce concurrent bulk-fill requests behind one promise. */
  private async ensureChannelsBulkFilled(slack: SlackClient): Promise<void> {
    if (this.channelBulkFillStarted) {
      if (this.channelBulkFill !== null) await this.channelBulkFill;
      return;
    }
    this.channelBulkFillStarted = true;
    this.channelBulkFill = (async () => {
      try {
        const { channels } = await slack.conversationsList({
          types: 'public_channel,private_channel',
          excludeArchived: true,
          limit: 1000,
        });
        for (const ch of channels) {
          if (ch.name !== undefined) {
            this.channels.set(ch.id, ch.name);
          }
        }
      } catch (err) {
        console.warn('[name-resolver] channels bulk fill failed (continuing lazy):', err);
      } finally {
        this.channelBulkFill = null;
      }
    })();
    await this.channelBulkFill;
  }

  /**
   * Test seam — pre-seed display names without hitting any API. Intended
   * for unit tests that exercise `rewriteMentions` without a live Slack
   * client.
   */
  primeForTests(users: Record<string, string>, channels: Record<string, string>): void {
    for (const [id, name] of Object.entries(users)) this.users.set(id, name);
    for (const [id, name] of Object.entries(channels)) this.channels.set(id, name);
  }

  /**
   * Synchronously rewrite mentions using only what's already cached — no
   * API calls. Unknown ids stay raw. Useful when you're inside a hot path
   * that can't afford async resolution and you've already done a primer
   * pass elsewhere.
   */
  rewriteMentionsCached(text: string): string {
    if (text.length === 0) return text;
    return text
      .replace(USER_MENTION_RE, (match, id: string) => {
        const name = this.users.get(id);
        return name != null ? `@${name}` : match;
      })
      .replace(CHANNEL_MENTION_RE, (match, id: string, inlineName?: string) =>
        this.renderChannelMention(match, id, inlineName),
      );
  }

  /** Test seam — clear all cached state. */
  clearForTests(): void {
    this.users.clear();
    this.channels.clear();
    this.channelBulkFill = null;
    this.channelBulkFillStarted = false;
  }

  // Type-only helpers to keep the file self-documenting; SlackChannelId / SlackUserId
  // are used at the boundary but the resolver speaks plain strings internally.
  static isUserId(s: string): s is SlackUserId {
    return /^[UW][A-Z0-9]+$/.test(s);
  }
  static isChannelId(s: string): s is SlackChannelId {
    return /^C[A-Z0-9]+$/.test(s);
  }
}
