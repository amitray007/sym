import type { Receipt, Turn, Usage } from '@sym/contracts';

export interface ReceiptParams {
  turn: Turn;
  model: string;
  usage?: Usage;
  durationMs?: number;
  toolsInvoked: string[];
}

/**
 * Build a `Receipt` from kernel execution metadata.
 */
export function buildReceipt(params: ReceiptParams): Receipt {
  const receipt: Receipt = {
    turnId: params.turn.id,
    model: params.model,
    toolsInvoked: params.toolsInvoked,
  };

  // Omit optional fields rather than setting them to `undefined`
  // (exactOptionalPropertyTypes requires absence, not undefined assignment).
  if (params.usage !== undefined) receipt.usage = params.usage;
  if (params.durationMs !== undefined) receipt.durationMs = params.durationMs;

  return receipt;
}
