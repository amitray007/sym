/**
 * In-flight destructive-tool confirmation registry.
 *
 * When the Pi loop encounters a tool marked `destructiveHint: true` it calls
 * `requestConfirmation`, which posts a Slack message with Confirm / Cancel
 * buttons and suspends the tool call until the owner clicks one (or the
 * timeout elapses).
 *
 * The interactivity endpoint (`POST /slack/interactivity`) calls
 * `resolveConfirmation` once it has verified the Slack signature, owner-gated
 * the click, and parsed the `action_id`.
 *
 * Security notes:
 *  - Confirmation ids are crypto-random UUIDs — unguessable from outside.
 *  - This map is in-process / in-memory. That is fine for single-owner Sym:
 *    there is exactly one agent process per installation, and the default
 *    timeout (120 s) cleans up dangling entries if the process restarts mid-flow.
 *  - The endpoint must owner-gate before calling resolveConfirmation; this
 *    module does NOT enforce ownership — it only tracks id ↔ resolver.
 */

import { actionsBlock, sectionBlock } from '@sym/adapter-slack';

import type { SlackClient } from '@sym/adapter-slack';
import type { SlackChannelId, SlackThreadTs } from '@sym/contracts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingConfirmation {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Singleton registry
// ---------------------------------------------------------------------------

/** Module-level map: confirmationId → pending resolver + cleanup timer. */
const pending = new Map<string, PendingConfirmation>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RequestConfirmationParams {
  slackClient: SlackClient;
  /** Channel to post the confirmation message in. */
  channel: SlackChannelId;
  /** Thread to post the confirmation into (if the turn is threaded). */
  threadTs?: SlackThreadTs;
  /** Human-readable tool name shown in the message. */
  toolName: string;
  /** Short preview of the arguments (pre-truncated by the caller). */
  argsPreview: string;
  /** How long to wait for a response before resolving false (default 120 000 ms). */
  timeoutMs?: number;
}

/**
 * Post a Slack confirmation prompt and wait for the owner's response.
 *
 * Returns `true` if the owner clicked Confirm, `false` on Cancel or timeout.
 *
 * The promise resolves as soon as `resolveConfirmation` is called (by the
 * interactivity endpoint) or the timeout fires.
 */
export async function requestConfirmation(params: RequestConfirmationParams): Promise<boolean> {
  const { slackClient, channel, threadTs, toolName, argsPreview, timeoutMs = 120_000 } = params;

  const id = crypto.randomUUID();

  // Build the Slack message.
  const preview = argsPreview.length > 200 ? `${argsPreview.slice(0, 197)}…` : argsPreview;

  const blocks = [
    sectionBlock(`⚠️ Sym wants to run *${toolName}* — approve?\n\`\`\`\n${preview}\n\`\`\``),
    actionsBlock([
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Confirm ✅', emoji: true },
        style: 'primary',
        action_id: `sym_confirm:${id}:approve`,
        value: id,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Cancel ✋', emoji: true },
        style: 'danger',
        action_id: `sym_confirm:${id}:deny`,
        value: id,
      },
    ]),
  ];

  // Post the message (best-effort; on failure we fail closed).
  try {
    await slackClient.chatPostMessage({
      channel,
      text: `⚠️ Sym wants to run *${toolName}* — approve?`,
      blocks,
      ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
    });
  } catch (err) {
    console.error('[confirmations] failed to post confirmation message:', err);
    // Fail closed: cannot confirm → deny.
    return false;
  }

  // Register and await.
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        console.warn(
          `[confirmations] confirmation ${id} for '${toolName}' timed out after ${timeoutMs}ms`,
        );
        resolve(false);
      }
    }, timeoutMs);

    pending.set(id, { resolve, timer });
  });
}

/**
 * Resolve an in-flight confirmation by id.
 *
 * Called by the interactivity endpoint after verifying the Slack signature
 * and owner-gating the click.  Returns `true` when the id was found (and
 * the pending promise has been settled), `false` when unknown / already settled.
 */
export function resolveConfirmation(confirmationId: string, approved: boolean): boolean {
  const entry = pending.get(confirmationId);
  if (!entry) return false;

  clearTimeout(entry.timer);
  pending.delete(confirmationId);
  entry.resolve(approved);
  return true;
}
