/**
 * LLM relevance guard for Slack-read tools.
 *
 * The model sometimes reaches for `search_messages` (a workspace-wide Slack
 * search) to "look busy" on a task that lives in an EXTERNAL system — a GitHub
 * PR, a cloud resource, an issue tracker. A Slack search can't answer those and
 * wastes a turn. It can also surface the owner's private Slack content into a
 * shared channel.
 *
 * This guard runs ONE fast LLM classification the first time a turn reaches for
 * a broad Slack read, and returns a verdict:
 *   - `allow`    — the request is genuinely about Slack conversations.
 *   - `redirect` — the request is an external-system task; block and tell the
 *                  model to use `find_tools` instead of a Slack search.
 *   - `confirm`  — it's a Slack operation but reading/surfacing it could expose
 *                  the owner's private content in a shared channel, or it's
 *                  ambiguous; ask the owner to approve before running.
 *
 * No hard-coded keyword lists: the model decides. The code only acts on the
 * verdict. This FAILS OPEN — any error, empty, or unrecognized response →
 * `allow`, so the guard can never break a legitimate Slack task.
 */

import { Agent } from '@earendil-works/pi-agent-core';

import { buildFireworksModel } from './pi/model.js';

import type { AgentEvent } from '@earendil-works/pi-agent-core';

/** Broad-reach Slack reads worth guarding (workspace-wide, privacy-sensitive). */
export const SLACK_GUARD_TOOLS = new Set<string>([
  'search_messages',
  'list_channels',
  'read_user_profile',
]);

export type SlackGuardVerdict = 'allow' | 'redirect' | 'confirm';

export interface SlackGuardDeps {
  fireworks: { baseUrl: string; apiKey: string };
  model: string;
  /** `'shared'` = reply visible to others in the channel; `'private'` = DM. */
  visibility: 'shared' | 'private';
}

function guardSystemPrompt(visibility: 'shared' | 'private'): string {
  return [
    'You are a routing guard. The owner sent a request to their Slack assistant, and the assistant is about to run a SLACK tool — one that searches or reads the owner’s Slack messages/people across the workspace. Slack tools can ONLY see Slack conversations; they cannot reach GitHub, cloud providers, CI, issue trackers, or any other external system.',
    '',
    `The assistant’s reply will be ${
      visibility === 'shared'
        ? 'posted in a SHARED channel where other people can read it'
        : 'sent privately to the owner only'
    }.`,
    '',
    'Classify the request into exactly one verdict:',
    '- ALLOW: it is a question ABOUT Slack conversations (a recap, finding a message/thread, who said what, catching up a channel). A Slack read is the right tool.',
    '- REDIRECT: it is a task in an EXTERNAL system (e.g. "raise a PR", "list my cloud resources", "what are my Sentry issues", "create a Linear ticket"). A Slack search is the WRONG tool — the assistant should use other connectors instead.',
    visibility === 'shared'
      ? '- CONFIRM: it is a Slack operation, but answering it would pull the owner’s private Slack content into this shared channel where others can read it, or it is ambiguous whether it should run here. The owner should approve first.'
      : '- CONFIRM: it is a Slack operation but genuinely ambiguous whether it should run; the owner should approve first.',
    '',
    'When unsure between ALLOW and REDIRECT, prefer ALLOW (do not block a plausible Slack request).',
    'Respond with EXACTLY one word — ALLOW, REDIRECT, or CONFIRM — and nothing else.',
  ].join('\n');
}

/** Map a raw model response to a verdict; anything unrecognized → `allow`. */
export function parseVerdict(raw: string): SlackGuardVerdict {
  const word = raw.toUpperCase().match(/\b(ALLOW|REDIRECT|CONFIRM)\b/);
  if (!word) return 'allow';
  if (word[1] === 'REDIRECT') return 'redirect';
  if (word[1] === 'CONFIRM') return 'confirm';
  return 'allow';
}

/**
 * Classify whether a Slack-read tool is the right move for `userMessage`.
 * One fast LLM call. Fails OPEN to `'allow'` on any error.
 */
export async function judgeSlackToolUse(
  userMessage: string,
  deps: SlackGuardDeps,
): Promise<SlackGuardVerdict> {
  if (userMessage.trim().length === 0) return 'allow';
  try {
    const model = buildFireworksModel({ baseUrl: deps.fireworks.baseUrl, modelId: deps.model });
    const agent = new Agent({
      initialState: {
        systemPrompt: guardSystemPrompt(deps.visibility),
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

    await agent.prompt(userMessage);
    return parseVerdict(out);
  } catch (err) {
    console.warn('[agent] slack guard failed (allowing):', err);
    return 'allow';
  }
}
