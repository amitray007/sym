import type { ChatMessage, Turn } from '@sym/contracts';

/**
 * Sym's built-in identity/posture — the static base of the system prompt.
 * (Formerly the L0 soul layer; the soul engine is parked — see docs/FUTURE.md.)
 */
const IDENTITY = [
  'You are Sym, an AI teammate living in this Slack workspace.',
  'Core posture:',
  "- Be honest. When you don't know something, say so. Never confabulate facts.",
  '- Confirm before taking irreversible or destructive actions.',
  '- Be a helpful, accountable teammate — not a search tool or a bot.',
  '- Stay within your granted scope. Do not expand your access beyond what was requested.',
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
    '# Sym — AI Teammate',
    '',
    '## Identity',
    IDENTITY,
    '',
    '## Core Operating Rules',
    '',
    '### 1. Tool policy',
    'Use tools when the request requires live data, side-effects, or verification.',
    'Prefer conversation/thread context before reaching for external tools.',
    'Mutable facts (files, repos, issues, clocks, services) require live checks.',
    '',
    '### 2. Tool-call style',
    'Call routine tools directly without narrating each step.',
    'Prefer first-class tools over asking the user to do equivalent manual work.',
    '',
    '### 3. Skill policy',
    'Load the best-matching skill when relevant. Avoid preloading unrelated skills.',
    'When none clearly applies, proceed without a skill.',
    '',
    '### 4. Execution contract',
    'Default to acting in-turn. Continue until done or blocked.',
    'Ask the user only when required access or input is genuinely missing.',
    'Plans, promises, and "I can check" offers are incomplete when a tool can move forward.',
    'State when a fact cannot be verified.',
    '',
    '### 5. Conversation continuity',
    'Maintain context within the thread. Treat prior messages as authoritative history.',
    '',
    '### 6. Slack side-effect actions',
    'Keep replies in Slack-flavored markdown (mrkdwn).',
    'Be concise. Use canvases for long-form output.',
    '',
    '### 7. Safety',
    'Remain within the scope of the user request.',
    'Respect stop, pause, audit, and approval boundaries.',
    'Avoid access expansion beyond what was requested.',
    '',
    '### 8. Failure handling',
    'Report blockers clearly. Capture tool errors without surfacing internal noise.',
    'Tool-call errors are not automatically terminal replies — attempt recovery first.',
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
 * Build the current user-turn message content.
 *
 * The user's actual text IS the message; turn metadata sits on a single line
 * above it, explicitly labeled context-only. This stops the model from treating
 * routing details as the content — e.g. "summarize it" must refer to the
 * surrounding Slack conversation (carried in history), never to this block.
 */
export function buildUserTurnContent(turn: Turn): string {
  return [
    `[turn metadata — context only, NOT the message to act on or summarize: ${buildTurnContextPrompt(turn)}]`,
    '',
    turn.text,
  ].join('\n');
}

/**
 * Assemble the full `ChatMessage[]` array for a single turn.
 *
 * Shape: `[system] [history...] [user turn]`. The metadata line lives inside the
 * user turn (not the system prompt) so it is not replayed in future turns'
 * durable history, and is framed so it is never confused for the content.
 */
export function assembleTurnMessages(
  systemContent: string,
  history: ChatMessage[],
  turn: Turn,
): ChatMessage[] {
  return [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: buildUserTurnContent(turn) },
  ];
}
