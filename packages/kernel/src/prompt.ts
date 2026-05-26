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
 * Per-turn volatile context block. Attached to the current user message.
 * Contains requester identity and thread context — must NOT be stored in
 * durable conversation history (per agent-prompt-spec §section-boundaries).
 */
export function buildTurnContextPrompt(turn: Turn): string {
  const lines = [
    '## Turn Context',
    `requester_id: ${turn.requester}`,
    `workspace_id: ${turn.workspaceId}`,
    `conversation_id: ${turn.conversationId}`,
    `entry_surface: ${turn.entrySurface}`,
    `received_at: ${turn.receivedAt.toISOString()}`,
  ];

  if (turn.channelId !== undefined) {
    lines.push(`channel_id: ${turn.channelId}`);
  }
  if (turn.threadTs !== undefined) {
    lines.push(`thread_ts: ${turn.threadTs}`);
  }

  return lines.join('\n');
}

/**
 * Assemble the full `ChatMessage[]` array for a single turn.
 *
 * Shape:
 *   [system] [history...] [user turn w/ context prefix]
 *
 * The context prefix is prepended to the user text so it stays out of the
 * system prompt and is not replayed in future turns' durable history.
 */
export function assembleTurnMessages(
  systemContent: string,
  history: ChatMessage[],
  turn: Turn,
): ChatMessage[] {
  const contextBlock = buildTurnContextPrompt(turn);
  const userContent = `${contextBlock}\n\n---\n\n${turn.text}`;

  return [
    { role: 'system', content: systemContent },
    ...history,
    { role: 'user', content: userContent },
  ];
}
