/**
 * Built-in tool: search_messages.
 *
 * Workspace-wide Slack message search using the owner's user token
 * (bot tokens cannot hold `search:read`). Includes per-turn result caching,
 * deduplication of repeated matches, and dual prose/table rendering.
 */

import { isSlackDmId } from '@sym/adapter-slack';

import { argError, clampedLimit, dedupeSearchMatches, errMsg, fieldsFor } from './_helpers.js';

import type { NameResolver } from '../name-resolver.js';
import type { SlackClient } from '@sym/adapter-slack';
import type {
  JsonSchema,
  RenderIntent,
  ToolCall,
  ToolDescriptor,
  ToolResult,
} from '@sym/contracts';

export const SEARCH_MESSAGES_DESCRIPTOR: ToolDescriptor = {
  type: 'function',
  name: 'search_messages',
  description: [
    'Search the owner\'s SLACK messages across the workspace (`search.messages`). USE ONLY for questions ABOUT SLACK CONVERSATIONS — recaps, "what did I say/do in Slack", "who did I talk to", finding a past message or thread. It does NOT reach GitHub, cloud, issue trackers, an app\'s data, or ANY external system — for anything outside Slack use `find_tools` (connectors/CLIs), NEVER this tool. (e.g. "raise a PR", "list cloud resources", "what are my sentry issues" are NOT search_messages tasks.) Within Slack-content questions it is the primary tool — it covers every channel + DM, not one — so reach for it before read_channel / list_channels when you don\'t know the channel.',
    '',
    'Query syntax — Slack search modifiers (combine freely):',
    '  - `from:<@U042MBPUZ9N>`        find messages from a user by ID (most reliable)',
    "  - `from:@amit`                 find messages from a user by @-handle (use the owner's userName from the metadata block)",
    '  - `to:@amit`                   messages addressed to a user',
    '  - `in:#general`                limit to one channel',
    '  - `after:2026-05-26`           AFTER a date (exclusive), YYYY-MM-DD',
    '  - `before:2026-05-28`          BEFORE a date (exclusive), YYYY-MM-DD',
    '  - `on:2026-05-27`              a single calendar day',
    '  - `has:link` / `has:reaction`  attribute filters',
    '  - Plain words match the message content (e.g. `postgres migration`)',
    '',
    'Dates: prefer EXPLICIT `after:`/`before:`/`on:` with YYYY-MM-DD (call get_current_time first if you need today\'s date) — they are far more reliable than relative words. For "today", bound it with `after:<yesterday> before:<tomorrow>` or `on:<today>`. Note `after:`/`before:` are EXCLUSIVE, so widen by a day on each side when you want a full day inclusive.',
    'Sort: defaults to relevance (`score`). For ANY recency-oriented ask — "today", "recent", "latest", "what did I just", a date range — pass `sort=timestamp` so newest comes first and nothing recent gets buried below the relevance cutoff.',
    '',
    'Concrete worked examples:',
    '  - "what did I do today?"           →  query `from:<@OWNER_ID> on:<today>`, sort=timestamp',
    '  - "who did I talk to yesterday?"   →  query `from:<@OWNER_ID> on:<yesterday>`, sort=timestamp',
    '  - "what did I post in #eng?"       →  `from:<@OWNER_ID> in:#eng`',
    '  - "find the postgres discussion"   →  `postgres migration`',
    '  - "who mentioned the launch plan?" →  `launch plan`',
    '',
    "OWNER_ID is the owner's user id from the turn metadata block. Returns the most relevant matches with permalinks.",
    'RELIABILITY: search is an INDEX — a message sent in the last minute or two may not be searchable yet. If you expect a very recent message and search comes back empty, read the channel directly with read_channel instead of concluding nothing happened. If a query with modifiers returns nothing, retry once with the plain keywords (drop from:/in:/dates) before giving up. An empty result after that means it genuinely matched nothing — say so plainly; don\'t fall back to "channels you belong to" language.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Slack search query. Supports modifiers: from:@user, in:#channel, before:YYYY-MM-DD, after:YYYY-MM-DD, has:link, etc.',
      },
      limit: {
        type: 'number',
        description:
          'Max results (default 20, max 100). Raise to 50+ for "everything I did" sweeps.',
      },
      sort: {
        type: 'string',
        enum: ['score', 'timestamp'],
        description: 'Rank by relevance (score, default) or recency (timestamp).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  } satisfies JsonSchema,
  readOnlyHint: true,
  // search.messages requires the user-token `search:read` scope (bot tokens
  // cannot hold it). Falls back to bot client only if Sym is configured
  // without a user token, in which case this tool will return an API error.
  actor: 'user',
};

export async function handleSearchMessages(
  call: ToolCall,
  slack: SlackClient,
  usedActor: 'bot' | 'user',
  resolver: NameResolver,
  searchCache: Map<string, ToolResult>,
): Promise<ToolResult> {
  const queryArg = call.arguments['query'];
  if (typeof queryArg !== 'string' || queryArg.trim().length === 0) {
    return argError(call, 'query must be a non-empty string');
  }
  if (usedActor !== 'user') {
    // Bot tokens cannot hold `search:read`, so search.messages always
    // fails when called as the bot. Surface a clean error rather than
    // letting Slack return a confusing missing_scope.
    return {
      callId: call.id,
      ok: false,
      error: {
        code: 'execution_failed',
        message:
          'workspace search requires SLACK_OWNER_USER_TOKEN — Slack bot tokens cannot hold the search:read scope',
      },
    };
  }
  const limit = clampedLimit(call.arguments['limit'], 20, 1, 100);
  const sortArg = call.arguments['sort'];
  const sort: 'score' | 'timestamp' = sortArg === 'timestamp' ? 'timestamp' : 'score';
  const cacheKey = `${queryArg.trim()}|${sort}|${limit}`;
  const cachedSearch = searchCache.get(cacheKey);
  if (cachedSearch !== undefined && cachedSearch.ok) {
    // Identical query already run this turn — reuse the payload with a
    // FRESH callId (Pi matches tool results by callId).
    console.info(
      `[tools] search_messages query=${JSON.stringify(queryArg.trim())} → cache hit (this turn)`,
    );
    return { ...cachedSearch, callId: call.id };
  }
  try {
    const startMs = Date.now();
    // Fetch headroom so dedup has room to surface unique messages even
    // when one line is repeated many times (Slack returns each repeat
    // as its own match). We still SHOW at most `limit` unique.
    const fetchCount = Math.min(100, Math.max(limit, 30));
    const { matches: rawMatches, total } = await slack.searchMessages({
      query: queryArg.trim(),
      count: fetchCount,
      sort,
    });
    // Visible-in-logs diagnostic so we can tell "didn't call it" from
    // "called it, got empty" when triaging "Sym says no activity"
    // reports. No message bodies — just query + count.
    console.info(
      `[tools] search_messages query=${JSON.stringify(queryArg.trim())} ` +
        `→ ${rawMatches.length}/${total} matches in ${Date.now() - startMs}ms`,
    );
    if (rawMatches.length === 0) {
      const result: ToolResult = { callId: call.id, ok: true, content: '(no matching messages)' };
      searchCache.set(cacheKey, result);
      return result;
    }
    // Collapse identical repeats (same author + text) so real content
    // isn't buried under copies, then show up to `limit` unique.
    const deduped = dedupeSearchMatches(rawMatches).slice(0, limit);
    const header =
      deduped.length < rawMatches.length
        ? `(${total} total matches; showing ${deduped.length} unique — identical repeats collapsed)\n`
        : total > rawMatches.length
          ? `(showing ${rawMatches.length} of ${total} matches)\n`
          : '';
    // Resolve author + channel/DM ids for the SHOWN matches upfront
    // so per-line formatting stays synchronous. A DM channel (`D…`)
    // resolves to its counterpart user; a real channel (`C…`) to its
    // name. A raw id must NEVER reach the model or the owner.
    const authorIds = deduped
      .map((d) => d.match.userId as string | undefined)
      .filter((id): id is string => id !== undefined && id.length > 0);
    const channelIds = deduped
      .map((d) => d.match.channelId as string | undefined)
      .filter((id): id is string => id !== undefined && id.length > 0);
    await Promise.all([
      ...authorIds.map((id) => resolver.resolveUser(id, slack)),
      ...channelIds.map((id) =>
        isSlackDmId(id)
          ? resolver.resolveDmParticipant(id, slack)
          : resolver.resolveChannel(id, slack),
      ),
    ]);
    const rewrittenTexts = await Promise.all(
      deduped.map((d) => resolver.rewriteMentions(d.match.text, slack)),
    );
    // Compute fields once per match — avoids the double-call (Z06-14).
    const allFields = deduped.map((d) => fieldsFor(d, resolver));
    const body = deduped
      .map((d, i) => {
        const { whoTag, whereTag, rep, permalink } = allFields[i]!;
        const raw = rewrittenTexts[i] ?? d.match.text;
        const link = permalink ? ` [link](${permalink})` : '';
        const content = raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
        return `${i + 1}. ${whoTag} in ${whereTag}${link}${rep}\n   ${content}`;
      })
      .join('\n');
    // Presentation hint: render the same matches as a Slack `table`
    // (code-owned blocks; the model still reasons over `content`).
    const render: RenderIntent = {
      kind: 'table',
      columns: [{ header: 'From' }, { header: 'Channel' }, { header: 'Message' }],
      rows: deduped.map((d, i) => {
        const { whoCell, whereCell, rep, permalink } = allFields[i]!;
        // Plain names in cells — tokens would render literally here.
        const raw = resolver.flattenToNames(rewrittenTexts[i] ?? d.match.text);
        const preview = raw.length > 140 ? `${raw.slice(0, 140)}…` : raw;
        // A message with no text (bot/app alerts whose content is in
        // attachments) would leave the cell empty — Slack rejects an
        // empty link cell. Use a readable placeholder instead.
        const text = `${preview}${rep}`.trim() || '(no message text)';
        return [
          { text: whoCell },
          { text: whereCell },
          permalink ? { text, link: permalink } : { text },
        ];
      }),
    };
    const result: ToolResult = { callId: call.id, ok: true, content: `${header}${body}`, render };
    searchCache.set(cacheKey, result);
    return result;
  } catch (err: unknown) {
    return {
      callId: call.id,
      ok: false,
      error: { code: 'execution_failed', message: errMsg(err) },
    };
  }
}
