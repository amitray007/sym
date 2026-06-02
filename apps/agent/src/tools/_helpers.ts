/**
 * Shared primitives for built-in tool implementations.
 *
 * Extracted to eliminate ~26× arg-error constructions, ~11× error-message
 * extractions, and ~18× cast patterns that were duplicated across the
 * monolithic builtin-tools.ts dispatcher. All helpers are pure (no I/O).
 */

import { isSlackChannelId, isSlackDmId, threadToHistory } from '@sym/adapter-slack';

import type { NameResolver } from '../name-resolver.js';
import type { SearchMessageMatch, SlackClient, SlackThreadMessage } from '@sym/adapter-slack';
import type { SlackUserId, ToolCall, ToolResult } from '@sym/contracts';

// ---------------------------------------------------------------------------
// Error / result builders
// ---------------------------------------------------------------------------

/** Build an `invalid_arguments` ToolResult. Replaces ~26 inline constructions. */
export function argError(call: ToolCall, message: string): ToolResult {
  return {
    callId: call.id,
    ok: false,
    error: { code: 'invalid_arguments', message },
  };
}

/** Build an `execution_failed` ToolResult. Replaces ~11 inline constructions. */
export function execError(call: ToolCall, message: string): ToolResult {
  return {
    callId: call.id,
    ok: false,
    error: { code: 'execution_failed', message },
  };
}

/** Extract a string message from an unknown thrown value. Replaces ~18 inline casts. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Argument coercion
// ---------------------------------------------------------------------------

/**
 * Clamp a model-supplied numeric limit to [min, max], falling back to
 * `defaultVal` when the argument is not a number.
 */
export function clampedLimit(arg: unknown, defaultVal: number, min: number, max: number): number {
  const raw = typeof arg === 'number' ? arg : defaultVal;
  return Math.max(min, Math.min(max, raw));
}

/** Coerce model-supplied card fields to valid {label,value} pairs (drops malformed). */
export function coerceCardFields(raw: unknown): { label: string; value: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { label: string; value: string }[] = [];
  for (const entry of raw) {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const label = (entry as Record<string, unknown>)['label'];
      const value = (entry as Record<string, unknown>)['value'];
      if (typeof label === 'string' && typeof value === 'string') out.push({ label, value });
    }
  }
  return out;
}

/** Coerce model-supplied card actions to valid {label,url} link buttons (https only). */
export function coerceCardActions(raw: unknown): { label: string; url: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { label: string; url: string }[] = [];
  for (const entry of raw) {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const label = (entry as Record<string, unknown>)['label'];
      const url = (entry as Record<string, unknown>)['url'];
      if (typeof label === 'string' && typeof url === 'string' && /^https?:\/\//.test(url)) {
        out.push({ label, url });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Slack formatting helpers
// ---------------------------------------------------------------------------

/**
 * Resolve every unique non-bot author id in `messages` to a display name via
 * the workspace-scoped resolver, returning a `Record<id, name>` for
 * `threadToHistory` to use as author labels. Failures fall through to raw
 * id (handled downstream).
 */
export async function resolveAuthorNames(
  messages: SlackThreadMessage[],
  botUserId: SlackUserId,
  slack: SlackClient,
  resolver: NameResolver,
): Promise<Record<string, string>> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.user !== undefined && m.user !== botUserId) ids.add(m.user);
  }
  await Promise.all([...ids].map((id) => resolver.resolveUser(id, slack)));
  const names: Record<string, string> = {};
  for (const id of ids) {
    const name = resolver.getUser(id);
    if (name !== undefined) names[id] = name;
  }
  return names;
}

/**
 * Format a list of Slack thread messages into a plain-text transcript with
 * display names resolved AND in-body mentions (`<@U…>`, `<#C…>`) rewritten
 * to `@Name` / `#name`. Sym's own posts are prefixed with "Sym:". When name
 * resolution fails, the raw id falls through — the model never sees raw
 * structured Slack markup, but it may see a bare id as last-resort context.
 */
export async function formatTranscript(
  messages: SlackThreadMessage[],
  botUserId: SlackUserId,
  slack: SlackClient,
  resolver: NameResolver,
): Promise<string> {
  const names = await resolveAuthorNames(messages, botUserId, slack, resolver);
  const mapped = threadToHistory(messages, { botUserId, names });
  if (mapped.length === 0) return '(no messages)';
  const joined = mapped
    .map((m) => (m.role === 'assistant' ? `Sym: ${m.content ?? ''}` : (m.content ?? '')))
    .join('\n');
  // Final pass: rewrite any `<@U…>` / `<#C…>` mentions in message bodies.
  // resolveAuthorNames only touched author ids; mentions of OTHER users
  // inside message text still need resolution.
  return resolver.rewriteMentions(joined, slack);
}

// ---------------------------------------------------------------------------
// Search result helpers
// ---------------------------------------------------------------------------

/** A search match plus how many identical copies it collapsed. */
export interface DedupedSearchMatch {
  match: SearchMessageMatch;
  count: number;
}

/**
 * Collapse identical search matches (same author + normalized text), preserving
 * order (best-by-sort first). Slack returns every repeat of a message as its
 * own match, so a frequently-repeated line (e.g. the same prompt sent many
 * times) can fill the result window with copies and bury unique content — the
 * model then sees a wall of one message and wrongly concludes "nothing here".
 * Keeps the first occurrence and counts the rest.
 */
export function dedupeSearchMatches(matches: SearchMessageMatch[]): DedupedSearchMatch[] {
  const seen = new Map<string, DedupedSearchMatch>();
  const order: string[] = [];
  for (const m of matches) {
    const norm = (m.text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    const key = `${m.userId ?? m.username ?? ''}|${norm}`;
    const hit = seen.get(key);
    if (hit) {
      hit.count += 1;
    } else {
      seen.set(key, { match: m, count: 1 });
      order.push(key);
    }
  }
  return order.map((k) => seen.get(k)!);
}

/**
 * Per-row display fields for a single search match, computed once and used for
 * both the prose body (`*Tag` variants — Slack mrkdwn renders `<@U…>` / `<#C…>`
 * as clickable tokens) and the table render (`*Cell` variants — plain names,
 * because raw Slack tokens don't render in table cells).
 *
 * This was previously called twice per match — once for the body and once for
 * the table row. Call it once and reuse.
 */
export function fieldsFor(
  d: DedupedSearchMatch,
  resolver: NameResolver,
): {
  whoTag: string;
  whoCell: string;
  whereTag: string;
  whereCell: string;
  rep: string;
  permalink: string | undefined;
} {
  const m = d.match;
  const name = m.userId !== undefined ? resolver.getUser(m.userId) : undefined;
  const whoTag = m.userId !== undefined ? `<@${m.userId}>` : (m.username ?? '(unknown)');
  const whoCell = name ?? m.username ?? '(unknown)';
  const cid = m.channelId;
  let whereTag: string;
  let whereCell: string;
  if (cid !== undefined && isSlackDmId(cid)) {
    const dm = resolver.getDmParticipant(cid);
    whereTag = dm.userId !== undefined ? `a DM with <@${dm.userId}>` : 'a DM';
    whereCell = dm.name !== undefined ? `DM with ${dm.name}` : 'Direct message';
  } else {
    const channelName = m.channelName ?? (cid !== undefined ? resolver.getChannel(cid) : undefined);
    if (cid !== undefined && isSlackChannelId(cid)) {
      whereTag = `<#${cid}>`;
      whereCell = channelName ? `#${channelName}` : '#channel';
    } else if (channelName) {
      whereTag = `#${channelName}`;
      whereCell = `#${channelName}`;
    } else {
      whereTag = 'a conversation';
      whereCell = 'a conversation';
    }
  }
  const rep = d.count > 1 ? ` (sent ${d.count}×)` : '';
  return { whoTag, whoCell, whereTag, whereCell, rep, permalink: m.permalink };
}

// ---------------------------------------------------------------------------
// HTML stripping
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags and collapse whitespace. Intentionally naive — no cheerio.
 * Good enough for letting the model read the textual content of a page.
 */
export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
