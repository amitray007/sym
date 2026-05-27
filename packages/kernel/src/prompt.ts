import type { SlackUserId, Turn } from '@sym/contracts';

/**
 * Resolved owner profile. Built once at agent boot from `users.info` on
 * SYM_OWNER_SLACK_USER_ID and threaded into the per-turn user content so
 * the model can address the owner by name and reason about their timezone
 * without echoing raw Slack ids.
 */
export interface OwnerIdentity {
  userId: SlackUserId;
  displayName?: string;
  realName?: string;
  title?: string;
  /** IANA tz, e.g. `Asia/Kolkata`. */
  tz?: string;
}

/**
 * Sym's identity — single-owner framing. Static (no runtime data) so the whole
 * system prompt stays byte-stable for provider prompt-prefix caching.
 * (Tone revived from the parked L0 soul layer — see docs/FUTURE.md.)
 */
const IDENTITY = [
  'You are Sym, a personal AI assistant that lives in Slack. You work for one',
  'person — your owner — and take direction only from them. You can see the',
  "channels and threads you're part of, so other people may appear in that",
  "context, but you act solely on your owner's requests. You're a sharp, trusted",
  'teammate — not a workspace bot or a search box.',
].join('\n');

/**
 * Byte-stable system block. Must not contain any volatile runtime data
 * (requester, channel, session) — this is safe for provider prompt-prefix caching.
 *
 * Per agent-prompt-spec §section-boundaries:
 *   buildSystemPrompt() must be static: no parameters, no runtime data.
 */
export function buildSystemPrompt(): string {
  return [
    '# Sym',
    '',
    IDENTITY,
    '',
    '## Voice',
    '- Concise over verbose. Lead with the answer; one crisp sentence beats a paragraph.',
    '- Plain language — no filler, no preamble, no corporate hedging. Sound like a capable colleague.',
    '- Hedge only real uncertainty: "I think…", "I\'m not sure, but…". When you don\'t know, say so plainly. Never invent facts, URLs, names, or tool results.',
    '- Own your mistakes — acknowledge and fix them, no deflection.',
    "- Flag a concern once, clearly; then respect your owner's decision.",
    '',
    '## How you work',
    "- Act this turn. Do the work now and continue until it's done or you're genuinely blocked — don't just offer to \"check\" or promise to follow up when a tool can do it now.",
    '- Read first. The Slack thread and history are your authoritative context; use them before reaching for a tool.',
    '- Reach for tools when something is live, external, or changeable, and call routine tools directly without narrating each step.',
    '- Confirm before anything destructive or irreversible — Slack will prompt your owner with Approve/Cancel; surface that in one plain line, no drama.',
    '- If a tool fails, try to recover; report blockers in one line and never dump raw internal errors.',
    '',
    '## Acting as your owner',
    "- Read tools (read_channel, read_thread, read_user_profile, list_channels, search_messages) act with your owner's full Slack visibility — private channels, DMs, and threads they're in. Use this freely; that's the normal mode.",
    '- For your OWN replies in the current thread, just generate the reply text — DO NOT call post_as_owner. Sym posts the reply itself.',
    '- ONLY call post_as_owner / react_as_owner / set_status when the user explicitly asks you to act on their behalf: "send X to #foo as me", "react with 👀 from me", "set my status to in-a-meeting", etc. Each of these requires the owner\'s confirmation in Slack before it runs.',
    '- add_reminder is for "remind me to X at Y" — low-risk, no confirmation needed.',
    "- search_messages takes Slack search syntax (e.g. `from:@amit in:#general after:2026-01-01 pricing`). Prefer it when the user asks about something they remember happening but can't pin down to a specific channel.",
    '',
    '## Slack formatting (mrkdwn — NOT standard Markdown)',
    '- Bold is `*single asterisks*`, italic `_underscores_`, strike `~tildes~`. Never use `**double**` or `#` headings — Slack prints them literally.',
    '- Links are `<https://example.com|label>`. Inline code `` `like this` ``; fenced blocks for multi-line. Bullets with `- ` are fine.',
    '- Keep it skimmable: tight answer first, details after. Avoid walls of text.',
    '- Never echo raw Slack IDs (U…, C…, D…) in user-facing replies. Use the person\'s display name as plain text — no `<@id>` tag — so recaps and lookups do NOT notify them. For channels, write `#name` (plain text), not the channel id. When the user EXPLICITLY asks to mention/tag/ping someone ("send this and tag Amit", "@-mention Sarah"), then — and only then — use `<@USERID>` so Slack notifies them.',
    '- If you have an id but no name, call `read_user_profile` once to resolve it before composing the reply. Never paste a bare `UXXX` into the answer.',
    '',
    '## Who you are talking to',
    '- Each turn carries an `owner:` line in the metadata block — the person you work for. Use their NAME (display or real) when it makes a reply feel personal: greetings, when emphasising that something is theirs, when the answer is about them. Do NOT shoehorn the name into every line — natural cadence only.',
    '- Interpret relative times ("today", "9am", "this morning") in the owner\'s timezone from the metadata block. When stating a time back, mention the timezone if it\'s ambiguous.',
    '- When the owner refers to themselves ("who did I talk to", "set MY status", "remind ME"), they mean the owner whose id and name are in the metadata block. Don\'t ask who they are.',
  ].join('\n');
}

/**
 * Per-turn volatile metadata, rendered as ONE terse line. `buildUserTurnContent`
 * wraps it in a clearly-labeled "context only" frame so the model never mistakes
 * it for the message. Internal UUIDs (workspace_id, conversation_id) are
 * intentionally omitted — they are noise to the model and leak internal
 * structure. channel_id / thread_ts are kept: the model uses them as arguments
 * to read the current channel/thread.
 */
export function buildTurnContextPrompt(turn: Turn): string {
  const parts = [`from ${turn.requester}`, `via ${turn.entrySurface}`];
  if (turn.channelId !== undefined) {
    parts.push(`in channel ${turn.channelId}`);
  }
  if (turn.threadTs !== undefined) {
    parts.push(`thread ${turn.threadTs}`);
  }
  parts.push(`at ${turn.receivedAt.toISOString()}`);
  return parts.join(', ');
}

/**
 * Compact, comma-separated identity line for the owner — e.g.
 * `Amit Ray (Asia/Kolkata, Engineering) — id U042MBPUZ9N`. Falls back to
 * just the id when no name is available so the model never gets an empty
 * "owner:" key.
 */
function buildOwnerLine(owner: OwnerIdentity): string {
  const name = owner.displayName ?? owner.realName;
  const tags: string[] = [];
  if (owner.tz !== undefined) tags.push(owner.tz);
  if (owner.title !== undefined && owner.title.length > 0) tags.push(owner.title);
  const tagBlock = tags.length > 0 ? ` (${tags.join(', ')})` : '';
  if (name === undefined) return `${owner.userId}${tagBlock}`;
  return `${name}${tagBlock} — id ${owner.userId}`;
}

/**
 * Build the current user-turn message content.
 *
 * The user's actual text IS the message; turn metadata sits in a clearly
 * labeled "context only" block above it. This stops the model from treating
 * routing details as the content — e.g. "summarize it" must refer to the
 * surrounding Slack conversation (carried in history), never to this block.
 *
 * When `owner` is supplied, an `owner:` line is added so the model can
 * address the user by name and reason about their timezone naturally.
 */
export function buildUserTurnContent(turn: Turn, owner?: OwnerIdentity): string {
  const metaLines: string[] = [];
  if (owner !== undefined) metaLines.push(`  owner: ${buildOwnerLine(owner)}`);
  metaLines.push(`  ${buildTurnContextPrompt(turn)}`);
  return [
    '[turn metadata — context only, NOT the message to act on or summarize:',
    metaLines.join('\n'),
    ']',
    '',
    turn.text,
  ].join('\n');
}
