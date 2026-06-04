/**
 * Workspace-scoped name resolver — normalizes raw Slack ids in tool returns
 * BEFORE the model ever sees them, and keeps Slack's own mention tokens intact
 * so the model's replies render as real, clickable @mentions and #channels.
 *
 * **Problem this solves.** Slack messages, search results, and channel
 * histories arrive with raw `<@U042…>` / `<#C0ABC|name>` markup AND with bare
 * conversation ids (`D041…` for a DM) in structured fields. Two failure modes:
 *  - a bare `D041…` / `U042…` id leaks into a reply (unreadable to the owner);
 *  - a mention is flattened to inert plain text, so "ping Sarah" doesn't.
 *
 * **The contract now.** We keep canonical Slack tokens verbatim — `<@U…>` and
 * `<#C…>` — because Slack's `markdown_text` renderer turns them into clickable,
 * notifying mentions (the owner asked for native tagging; pings are expected).
 * What we eliminate is RAW ids with no token wrapper: a DM channel id (`D…`)
 * becomes its counterpart `<@U…>`; a bare/`<#U…>`-style id becomes `<@U…>`.
 *
 * **Three stores, three fill strategies.**
 *  - **Users**: eager + lazy. Bulk `users.list` at boot warms id→name; lazy
 *    `users.info` fills anything the bulk missed (external/shared users).
 *  - **Channels**: eager. Bulk `conversations.list` at boot (public + private
 *    the bot can see). Lazy fallback for ids the bulk missed.
 *  - **DMs**: lazy. A `D…` id maps to exactly one counterpart user; we resolve
 *    it via `conversations.info` once and remember `D… → U…`.
 *
 * **Lifecycle.** One resolver per agent process. Survives across turns.
 * Concurrent boot fills are coalesced via a single promise so racing turns
 * don't trigger duplicate bulk calls.
 *
 * **What we DON'T do.**
 *  - No TTL / expiry. Display names rarely change; if they do, restart the
 *    agent or pay the next lookup. Premature complexity otherwise.
 *  - No write path beyond emitting tokens. Composing fresh mentions ("ping
 *    Sarah") is the model's job, guided by the system prompt + the ids it
 *    sees in tool returns.
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
 * shape and rely on (a) the channel cache for normal `C…` ids, (b) the DM
 * cache for `D…` ids, (c) the inline label as fallback for weird shapes.
 */
const CHANNEL_MENTION_RE = /<#([A-Z][A-Z0-9]+)(?:\|([^>]*))?>/g;

/**
 * True only for a DEFINITIVE "not found" Slack error — the only case worth
 * caching as a sticky miss. Transient failures (rate_limited / network / 5xx)
 * return false so the resolver retries them on a later turn instead of pinning
 * the id to its raw form for the whole process. SlackError carries the raw
 * Slack error string on `.message`; we also check `.code` / `.cause.code`.
 */
function isDefinitiveNotFound(err: unknown, pattern: RegExp): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const parts: string[] = [];
  const rec = err as Record<string, unknown>;
  if (typeof rec['message'] === 'string') parts.push(rec['message']);
  if (typeof rec['code'] === 'string') parts.push(rec['code']);
  const cause = rec['cause'];
  if (typeof cause === 'object' && cause !== null) {
    const c = (cause as Record<string, unknown>)['code'];
    if (typeof c === 'string') parts.push(c);
  }
  return pattern.test(parts.join(' '));
}

const USER_NOT_FOUND = /\busers?_not_found\b/;
/** `channel_not_found` covers a deleted/inaccessible DM in conversations.info. */
const CHANNEL_NOT_FOUND = /\bchannel_not_found\b/;

export class NameResolver {
  private readonly users = new Map<string, CacheValue>();
  private readonly channels = new Map<string, CacheValue>();
  /** DM channel id (`D…`) → the OTHER participant's user id. */
  private readonly dms = new Map<string, CacheValue>();
  /** In-flight user lookups, coalesced so concurrent resolves of the same id share one API call. */
  private readonly inflightUsers = new Map<string, Promise<string>>();
  /** In-flight DM lookups, coalesced like users. */
  private readonly inflightDms = new Map<string, Promise<string | undefined>>();
  private channelBulkFill: Promise<void> | null = null;
  private channelBulkFillStarted = false;
  private userBulkFill: Promise<void> | null = null;
  private userBulkFillStarted = false;

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
   * Synchronous DM-counterpart accessor. Returns `{ userId, name }` for a
   * resolved `D…` id (name present only if the user is also cached), or an
   * empty object when unknown.
   */
  getDmParticipant(id: string): { userId?: string; name?: string } {
    const userId = this.dms.get(id);
    if (userId == null) return {};
    const name = this.users.get(userId);
    return name != null ? { userId, name } : { userId };
  }

  /**
   * Resolve a single user id to a display name, hitting `users.info` on cache
   * miss. Concurrent resolves of the SAME id are coalesced into one API call
   * (a turn often references the same author many times). On failure: a
   * definitive user-not-found is cached as a sticky null; transient errors are
   * left uncached so a later turn retries. Callers get the raw id on a miss.
   */
  async resolveUser(id: string, slack: SlackClient): Promise<string> {
    if (this.users.has(id)) {
      return this.users.get(id) ?? id;
    }
    const existing = this.inflightUsers.get(id);
    if (existing !== undefined) return existing;

    const inflight = (async (): Promise<string> => {
      try {
        const p = await slack.usersInfo({ user: id as SlackUserId });
        const name = p.displayName ?? p.realName ?? p.userName ?? null;
        this.users.set(id, name);
        return name ?? id;
      } catch (err) {
        // Only make the miss STICKY for a definitive user-not-found. A transient
        // failure (rate_limited / network / 5xx) must NOT poison the cache for
        // the process lifetime — leave it uncached so a later turn retries
        // (audit #5).
        if (isDefinitiveNotFound(err, USER_NOT_FOUND)) {
          this.users.set(id, null);
        }
        return id;
      } finally {
        this.inflightUsers.delete(id);
      }
    })();
    this.inflightUsers.set(id, inflight);
    return inflight;
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
   * Resolve a DM channel id (`D…`) to its counterpart's display name via
   * `conversations.info` → `users.info`. Caches `D… → U…` so we only pay the
   * info call once. Returns `undefined` when the DM can't be resolved (so
   * callers fall back to a generic phrase, never the raw `D…` id). Coalesces
   * concurrent resolves of the same id.
   */
  async resolveDmParticipant(id: string, slack: SlackClient): Promise<string | undefined> {
    const cachedUser = this.dms.get(id);
    if (cachedUser === null) return undefined; // sticky miss
    if (cachedUser !== undefined) {
      const name = await this.resolveUser(cachedUser, slack);
      return name === cachedUser ? undefined : name;
    }
    const existing = this.inflightDms.get(id);
    if (existing !== undefined) return existing;

    const inflight = (async (): Promise<string | undefined> => {
      try {
        const info = await slack.conversationsInfo({ channel: id as SlackChannelId });
        if (!info.isIm || info.userId === undefined) {
          // Not a 1:1 DM (or Slack gave no counterpart) — sticky miss; an
          // MPIM has no single counterpart to name.
          this.dms.set(id, null);
          return undefined;
        }
        this.dms.set(id, info.userId);
        const name = await this.resolveUser(info.userId, slack);
        return name === info.userId ? undefined : name;
      } catch (err) {
        if (isDefinitiveNotFound(err, CHANNEL_NOT_FOUND)) {
          this.dms.set(id, null);
        }
        return undefined;
      } finally {
        this.inflightDms.delete(id);
      }
    })();
    this.inflightDms.set(id, inflight);
    return inflight;
  }

  /**
   * Normalize Slack ids in `text` so the model sees clean, render-ready
   * content. Canonical mention tokens (`<@U…>`, `<#C…>`) are KEPT VERBATIM —
   * Slack renders them as clickable mentions in the reply. DM-style markup
   * (`<#U…|…>`, `<#D…|…>`) is rewritten to the counterpart `<@U…>` so the
   * person is tagged instead of a raw id leaking. Unknown ids fall back to
   * the inline label or the original markup — never a bare id in prose.
   *
   * Resolution is best-effort and parallel across distinct ids; the caches it
   * warms also feed `flattenToNames` (titles) and table cells.
   *
   * Used on every tool return that surfaces Slack text to the model.
   */
  async rewriteMentions(text: string, slack: SlackClient): Promise<string> {
    if (text.length === 0) return text;

    // Collect unique unknown ids in one pass so concurrent resolves run in parallel.
    const userIds = new Set<string>();
    const channelIds = new Set<string>();
    const dmIds = new Set<string>();
    for (const m of text.matchAll(USER_MENTION_RE)) {
      const id = m[1]!;
      if (!this.users.has(id)) userIds.add(id);
    }
    for (const m of text.matchAll(CHANNEL_MENTION_RE)) {
      const id = m[1]!;
      if (id.startsWith('C')) {
        if (!this.channels.has(id)) channelIds.add(id);
      } else if ((id.startsWith('U') || id.startsWith('W')) && !this.users.has(id)) {
        // DM-style markup carrying the OTHER party's USER id — resolve as a user.
        userIds.add(id);
      } else if (id.startsWith('D') && !this.dms.has(id)) {
        // A DM channel id wrapped in channel-link markup — resolve its counterpart.
        dmIds.add(id);
      }
      // G… (MPIM): no single counterpart; handled by the inline label below.
    }

    await Promise.all([
      ...[...userIds].map((id) => this.resolveUser(id, slack)),
      ...[...channelIds].map((id) => this.resolveChannel(id, slack)),
      ...[...dmIds].map((id) => this.resolveDmParticipant(id, slack)),
    ]);

    return this.rewriteMentionsCached(text);
  }

  /**
   * Best-effort boot-time bulk fill of channels (public + private the bot
   * can see). Fire-and-forget from the caller — failures log a warning and
   * leave the resolver in lazy mode. Idempotent: subsequent calls are no-ops.
   */
  async populateChannels(slack: SlackClient): Promise<void> {
    await this.ensureChannelsBulkFilled(slack);
  }

  /**
   * Best-effort boot-time bulk fill of workspace users via `users.list`, so
   * `<@U…>` ids resolve to names without a per-id `users.info` round-trip.
   * Skips deleted members (they'd never be mentioned anyway). Fire-and-forget;
   * lazy `resolveUser` still covers anyone the bulk missed (shared/external).
   */
  async populateUsers(slack: SlackClient): Promise<void> {
    await this.ensureUsersBulkFilled(slack);
  }

  /** Internal — coalesce concurrent channel bulk-fill requests behind one promise. */
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

  /** Internal — coalesce concurrent user bulk-fill requests behind one promise. */
  private async ensureUsersBulkFilled(slack: SlackClient): Promise<void> {
    if (this.userBulkFillStarted) {
      if (this.userBulkFill !== null) await this.userBulkFill;
      return;
    }
    this.userBulkFillStarted = true;
    this.userBulkFill = (async () => {
      try {
        const { users } = await slack.usersList({ limit: 2000 });
        for (const u of users) {
          if (u.deleted === true) continue;
          const name = u.displayName ?? u.realName ?? u.userName;
          // Don't clobber a name a lazy lookup already resolved with `null`.
          if (name !== undefined && name.length > 0 && !this.users.has(u.id)) {
            this.users.set(u.id, name);
          }
        }
      } catch (err) {
        console.warn('[name-resolver] users bulk fill failed (continuing lazy):', err);
      } finally {
        this.userBulkFill = null;
      }
    })();
    await this.userBulkFill;
  }

  /**
   * Synchronously rewrite mentions using only what's already cached — no
   * API calls. Canonical `<@U…>` / `<#C…>` tokens are preserved; DM-style
   * ids resolve from cache to `<@U…>`. Unknown ids keep their inline label or
   * the original markup. Useful when you've already done an async primer pass.
   */
  rewriteMentionsCached(text: string): string {
    if (text.length === 0) return text;
    return text
      .replace(USER_MENTION_RE, (match) => match) // canonical user mention — Slack renders it
      .replace(CHANNEL_MENTION_RE, (match, id: string, inlineName?: string) =>
        this.renderChannelMention(match, id, inlineName),
      );
  }

  /**
   * Render a `<#…|label>` token to a render-ready form:
   *  - `C…` — keep `<#C…>` (Slack renders the live channel name, clickable).
   *  - `U…`/`W…` — a DM whose markup carries the OTHER party's USER id; emit
   *    `<@U…>` so the person is tagged. NEVER fall back to the raw id.
   *  - `D…` — a DM channel id; emit the counterpart `<@U…>` if cached, else
   *    the inline label, else a generic phrase. NEVER the raw `D…`.
   *  - anything else (`G…` MPIM) — inline label or original markup.
   */
  private renderChannelMention(match: string, id: string, inlineName?: string): string {
    if (id.startsWith('C')) {
      // Keep the canonical token; Slack renders `#current-name` and it's clickable.
      return `<#${id}>`;
    }
    if (id.startsWith('U') || id.startsWith('W')) {
      return `<@${id}>`;
    }
    if (id.startsWith('D')) {
      const { userId } = this.getDmParticipant(id);
      if (userId !== undefined) return `<@${userId}>`;
      if (inlineName != null && inlineName.length > 0) return inlineName;
      return 'a direct message';
    }
    if (inlineName != null && inlineName.length > 0) return inlineName;
    return match;
  }

  /**
   * Flatten mention tokens to plain, non-tagging names — for surfaces that
   * are NOT rendered as Slack mrkdwn (e.g. assistant thread titles), where a
   * raw `<@U…>` token would either show literally or be stripped to nothing.
   * Cache-only (synchronous): `<@U…>` → `@name`, `<#C…>` → `#name`,
   * `<#U…>` → `@name`. Unknown ids are dropped (an empty mention is better
   * than a leaked id in a title).
   */
  flattenToNames(text: string): string {
    if (text.length === 0) return text;
    return text
      .replace(USER_MENTION_RE, (_match, id: string) => {
        const name = this.users.get(id);
        return name != null ? `@${name}` : '';
      })
      .replace(CHANNEL_MENTION_RE, (_match, id: string, inlineName?: string) => {
        if (id.startsWith('C')) {
          const name = this.channels.get(id) ?? inlineName;
          return name != null && name.length > 0 ? `#${name}` : '';
        }
        if (id.startsWith('U') || id.startsWith('W')) {
          const name = this.users.get(id);
          return name != null ? `@${name}` : '';
        }
        if (id.startsWith('D')) {
          const { name } = this.getDmParticipant(id);
          return name != null ? `@${name}` : '';
        }
        return inlineName ?? '';
      });
  }

  /**
   * Test seam — pre-seed cached names without hitting any API. `dms` maps a
   * `D…` id to the counterpart user id (which should also be primed in `users`
   * for the name to resolve).
   */
  primeForTests(
    users: Record<string, string>,
    channels: Record<string, string>,
    dms: Record<string, string> = {},
  ): void {
    for (const [id, name] of Object.entries(users)) this.users.set(id, name);
    for (const [id, name] of Object.entries(channels)) this.channels.set(id, name);
    for (const [id, userId] of Object.entries(dms)) this.dms.set(id, userId);
  }

  /** Test seam — clear all cached state. */
  clearForTests(): void {
    this.users.clear();
    this.channels.clear();
    this.dms.clear();
    this.inflightUsers.clear();
    this.inflightDms.clear();
    this.channelBulkFill = null;
    this.channelBulkFillStarted = false;
    this.userBulkFill = null;
    this.userBulkFillStarted = false;
  }
}
