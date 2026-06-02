/**
 * LLM cleanup backstop — removes the model's own plan/step narration from a
 * reply WITHOUT rewriting or paraphrasing the answer.
 *
 * Why span-removal, not rewrite: asking the model to "return the cleaned
 * answer" lets it drop or alter real content (observed: whole answers lost, or
 * details silently removed). Instead we ask it to identify the narration
 * fragments VERBATIM, then delete only those exact spans from the draft. This
 * fails SAFE toward keeping content:
 *   - a fragment the model invents or mis-quotes isn't found in the draft and is
 *     skipped — we never remove anything that isn't an exact, model-flagged span;
 *   - the answer text is never rewritten, reordered, or summarized — it's the
 *     original draft minus the flagged spans;
 *   - any error / no fragments / empty result → the original draft unchanged.
 *
 * No hard-coded narration patterns: the model decides what's narration, the
 * code only performs verbatim deletion. Suited to free-form AI content.
 */

import { Agent } from '@earendil-works/pi-agent-core';

import { buildFireworksModel } from './pi/model.js';

import type { AgentEvent } from '@earendil-works/pi-agent-core';

const CLEANUP_SYSTEM_PROMPT = [
  'A draft Slack reply may contain the assistant’s own planning or step narration mixed in with the actual answer — for example "Now start p1.", "Search messages in #x.", "We’ll craft the summary.", "Now reply." appearing before or between the real answer.',
  '',
  'Identify ONLY those narration/planning fragments — the assistant talking to itself about its steps, tools, or plan items. NEVER include any part of the real answer to the user (facts, recaps, names, numbers, links, recommendations).',
  '',
  'Respond with ONLY a JSON object: {"remove": ["<fragment>", ...]}',
  '- Copy each fragment VERBATIM from the draft (exact characters and punctuation).',
  '- Include a fragment ONLY if you are confident it is narration. When in doubt, leave it out.',
  '- If the draft contains no narration, return {"remove": []}.',
  'Output the JSON object and nothing else.',
].join('\n');

export interface ReplyCleanupDeps {
  fireworks: { baseUrl: string; apiKey: string };
  model: string;
}

// ---------------------------------------------------------------------------
// Model memoization — `buildFireworksModel` is pure / referentially stable for
// a given (baseUrl, modelId) pair. Rebuilding it on every cleanup call allocates
// a new object with no behavioural difference. Cache keyed by "<baseUrl>::<modelId>".
// ---------------------------------------------------------------------------

type FireworksModel = ReturnType<typeof buildFireworksModel>;
const _modelCache = new Map<string, FireworksModel>();

function _getCachedModel(baseUrl: string, modelId: string): FireworksModel {
  const key = `${baseUrl}::${modelId}`;
  const cached = _modelCache.get(key);
  if (cached !== undefined) return cached;
  const model = buildFireworksModel({ baseUrl, modelId });
  _modelCache.set(key, model);
  return model;
}

/**
 * Minimum fragment length to act on. Narration the model flags is full
 * phrases/sentences ("Now reply.", "Mark p1 complete."); a 1–5 char fragment
 * ('.', 'the', 'I') would `split().join('')` ALL its occurrences out of the
 * real answer too. Below this we leave it (fail toward keeping content).
 */
const MIN_FRAGMENT_LEN = 6;

/**
 * Tolerantly parse `{"remove": string[]}` from a model response (may be fenced).
 *
 * @internal — exported for tests only; use `cleanupReply` for production callers.
 */
export function parseRemovals(raw: string): string[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { remove?: unknown };
    if (!Array.isArray(obj.remove)) return [];
    return obj.remove.filter(
      (f): f is string => typeof f === 'string' && f.trim().length >= MIN_FRAGMENT_LEN,
    );
  } catch {
    return [];
  }
}

/**
 * Delete each verbatim fragment from the draft, then tidy leftover whitespace.
 *
 * @internal — exported for tests only; use `cleanupReply` for production callers.
 */
export function applyRemovals(draft: string, fragments: string[]): string {
  let out = draft;
  for (const frag of fragments) {
    if (out.includes(frag)) out = out.split(frag).join('');
  }
  return out
    .replace(/[ \t]+\n/g, '\n') // trailing spaces left by a removal
    .replace(/\n{3,}/g, '\n\n') // collapse blank-line runs
    .trim();
}

/**
 * Remove model narration from a draft via one LLM call — the draft minus the
 * model-flagged verbatim spans. Fails open to the original draft.
 */
export async function cleanupReply(draft: string, deps: ReplyCleanupDeps): Promise<string> {
  if (draft.trim().length === 0) return draft;
  try {
    const model = _getCachedModel(deps.fireworks.baseUrl, deps.model);
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

    const fragments = parseRemovals(out);
    if (fragments.length === 0) return draft;
    const cleaned = applyRemovals(draft, fragments);
    return cleaned.length > 0 ? cleaned : draft;
  } catch (err) {
    console.warn('[agent] reply cleanup failed (using draft):', err);
    return draft;
  }
}
