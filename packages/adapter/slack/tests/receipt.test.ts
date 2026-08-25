import { describe, expect, it } from 'vitest';

import { receiptToContextBlock, receiptToFooterFields } from '../src/receipt.js';

import type { Receipt, SlackUserId, TurnId } from '@sym/contracts';

function makeReceipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    turnId: 'turn-001' as TurnId,
    model: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
    toolsInvoked: [],
    ...overrides,
  };
}

describe('receiptToFooterFields', () => {
  it('always includes model field', () => {
    const fields = receiptToFooterFields(makeReceipt());
    const model = fields.find((f) => f.label === 'model');
    expect(model).toBeDefined();
    expect(model!.value).toContain('llama');
  });

  it('includes token counts when usage is present', () => {
    const fields = receiptToFooterFields(
      makeReceipt({ usage: { promptTokens: 1024, completionTokens: 256, totalTokens: 1280 } }),
    );
    const tokens = fields.find((f) => f.label === 'tokens');
    expect(tokens).toBeDefined();
    expect(tokens!.value).toBe('1024↑ 256↓');
  });

  it('omits tokens when usage is absent', () => {
    const fields = receiptToFooterFields(makeReceipt());
    expect(fields.find((f) => f.label === 'tokens')).toBeUndefined();
  });

  it('includes duration when durationMs is present', () => {
    const fields = receiptToFooterFields(makeReceipt({ durationMs: 2450 }));
    const dur = fields.find((f) => f.label === 'duration');
    expect(dur).toBeDefined();
    expect(dur!.value).toBe('2.5s');
  });

  it('omits duration when durationMs is absent', () => {
    const fields = receiptToFooterFields(makeReceipt());
    expect(fields.find((f) => f.label === 'duration')).toBeUndefined();
  });

  it('includes tools when toolsInvoked is non-empty', () => {
    const fields = receiptToFooterFields(
      makeReceipt({ toolsInvoked: ['github.list_prs', 'linear.create_issue'] }),
    );
    const tools = fields.find((f) => f.label === 'tools');
    expect(tools).toBeDefined();
    expect(tools!.value).toBe('github.list_prs, linear.create_issue');
  });

  it('omits tools when toolsInvoked is empty', () => {
    const fields = receiptToFooterFields(makeReceipt({ toolsInvoked: [] }));
    expect(fields.find((f) => f.label === 'tools')).toBeUndefined();
  });

  it('includes onBehalfOf when set', () => {
    const fields = receiptToFooterFields(makeReceipt({ onBehalfOf: 'U999' as SlackUserId }));
    const obo = fields.find((f) => f.label === 'on behalf of');
    expect(obo).toBeDefined();
    expect(obo!.value).toBe('<@U999>');
  });
});

describe('receiptToContextBlock', () => {
  it('produces a context block from receipt', () => {
    const block = receiptToContextBlock(
      makeReceipt({ usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } }),
    );
    expect(block.type).toBe('context');
    expect(block.elements.length).toBeGreaterThan(0);
    // Each element is a mrkdwn element
    for (const el of block.elements) {
      expect((el as { type: string }).type).toBe('mrkdwn');
    }
  });

  it('formats each field as "_label:_ value"', () => {
    const block = receiptToContextBlock(makeReceipt());
    const modelEl = block.elements.find((el) => (el as { text: string }).text.includes('model')) as
      { text: string } | undefined;
    expect(modelEl).toBeDefined();
    expect(modelEl!.text).toMatch(/^_model:_ /);
  });
});
