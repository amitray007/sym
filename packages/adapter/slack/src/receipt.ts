import { contextBlock, mrkdwnElement } from './blocks.js';

import type { ContextBlock } from './blocks.js';
import type { Receipt, ReceiptFooterField } from '@sym/contracts';

/**
 * Converts a `Receipt` (built by `@sym/kernel`) into an
 * ordered array of `ReceiptFooterField` label/value pairs.
 *
 * Rendering rules (per outbound contract spec):
 *   - model: always shown (shortened to last path segment for readability)
 *   - tokens: shown only when `usage` is present
 *   - duration: shown only when `durationMs` is present; rounded to 1 decimal
 *   - tools: shown only when `toolsInvoked` is non-empty
 *   - on behalf of: shown only when `onBehalfOf` is set
 */
export function receiptToFooterFields(receipt: Receipt): ReceiptFooterField[] {
  const fields: ReceiptFooterField[] = [];

  // Model — shorten to last path segment (e.g. `accounts/.../llama-v3...` → `llama-v3...`)
  const modelParts = receipt.model.split('/');
  const modelShort = modelParts[modelParts.length - 1] ?? receipt.model;
  fields.push({ label: 'model', value: modelShort });

  // Tokens
  if (receipt.usage) {
    const { promptTokens, completionTokens } = receipt.usage;
    fields.push({ label: 'tokens', value: `${promptTokens}↑ ${completionTokens}↓` });
  }

  // Duration — round to 1 decimal in seconds
  if (receipt.durationMs !== undefined) {
    const seconds = (receipt.durationMs / 1000).toFixed(1);
    fields.push({ label: 'duration', value: `${seconds}s` });
  }

  // Tools invoked
  if (receipt.toolsInvoked.length > 0) {
    fields.push({ label: 'tools', value: receipt.toolsInvoked.join(', ') });
  }

  // On behalf of
  if (receipt.onBehalfOf !== undefined) {
    fields.push({ label: 'on behalf of', value: `<@${receipt.onBehalfOf}>` });
  }

  return fields;
}

/**
 * Converts a `Receipt` into a Slack `context` block for attachment to a
 * finalized reply footer. Each footer field becomes a `mrkdwn` element
 * formatted as `_label:_ value`.
 */
export function receiptToContextBlock(receipt: Receipt): ContextBlock {
  const fields = receiptToFooterFields(receipt);
  const elements = fields.map((f) => mrkdwnElement(`_${f.label}:_ ${f.value}`));
  return contextBlock(elements);
}
