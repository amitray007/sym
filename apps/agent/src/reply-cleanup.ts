/**
 * LLM cleanup backstop for reply text.
 *
 * The streamed reply from gpt-oss-120b sometimes carries the model's own plan
 * narration ("Now start p1.Start p2.…Now reply.Here's the answer…") before the
 * actual answer. The regex {@link stripNarration} filter is a cheap live-noise
 * reducer, but it's hard-coded pattern matching that misses novel phrasings.
 * This module is the authoritative pass: a single LLM call that returns ONLY
 * the user-facing answer.
 *
 * Used as a BACKSTOP on multi-step turns (where narration tends to leak) — the
 * live stream shows the regex-filtered text, then the final message is settled
 * to this clean version. Fails OPEN: any error returns the draft unchanged (a
 * draft that still has narration beats dropping the answer).
 */

import { Agent } from '@earendil-works/pi-agent-core';

import { stripNarration } from './narration-filter.js';
import { buildFireworksModel } from './pi/model.js';

import type { AgentEvent } from '@earendil-works/pi-agent-core';

const CLEANUP_SYSTEM_PROMPT = [
  'You are a cleanup filter for a Slack assistant. The INPUT is a draft reply that may contain the assistant’s internal planning or step narration mixed in with the actual answer — for example "Now start p1.", "Search messages in #x.", "Now get profile.", "We’ll craft the summary.", "Now reply." followed by the real answer.',
  '',
  'Return ONLY the final, user-facing answer:',
  '- Remove every planning line, step announcement, plan-item id (p1/p2/…), tool or loop narration, and "now I will…" self-talk.',
  '- Keep the actual answer EXACTLY as written — same wording, same Markdown, same links. Do NOT rephrase, summarize, shorten, expand, or add anything of your own.',
  '- No preamble, no sign-off, no commentary. Output the cleaned answer text and nothing else.',
  '- If the input contains no narration, return it unchanged.',
].join('\n');

export interface ReplyCleanupDeps {
  fireworks: { baseUrl: string; apiKey: string };
  model: string;
}

/**
 * Strip planning/narration from a draft reply via a single LLM call, returning
 * only the user-facing answer. Fails open to the draft on any error or empty
 * result.
 */
export async function cleanupReply(draft: string, deps: ReplyCleanupDeps): Promise<string> {
  if (draft.trim().length === 0) return draft;
  try {
    const model = buildFireworksModel({ baseUrl: deps.fireworks.baseUrl, modelId: deps.model });
    const agent = new Agent({
      initialState: {
        systemPrompt: CLEANUP_SYSTEM_PROMPT,
        model,
        tools: [],
        messages: [],
        thinkingLevel: 'low',
      },
      getApiKey: (_provider: string) => deps.fireworks.apiKey,
    });

    let out = '';
    agent.subscribe((event: AgentEvent) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        out += event.assistantMessageEvent.delta;
      }
    });

    await agent.prompt(draft);

    // Belt: run the cheap regex over the LLM output too (in case the cleanup
    // model adds its own stray preamble), then guard empty → fail open.
    const cleaned = stripNarration(out).trim();
    return cleaned.length > 0 ? cleaned : draft;
  } catch (err) {
    console.warn('[agent] reply cleanup failed (using draft):', err);
    return draft;
  }
}
