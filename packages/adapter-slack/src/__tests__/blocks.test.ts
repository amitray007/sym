import { describe, expect, it } from 'vitest';

import {
  actionsBlock,
  contextBlock,
  dividerBlock,
  headerBlock,
  markdownBlock,
  mrkdwnElement,
  plainTextElement,
  sectionBlock,
} from '../blocks.js';

describe('markdownBlock', () => {
  it('produces correct shape', () => {
    expect(markdownBlock('**hello**')).toEqual({ type: 'markdown', text: '**hello**' });
  });
});

describe('sectionBlock', () => {
  it('produces correct shape without fields', () => {
    expect(sectionBlock('some text')).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: 'some text' },
    });
  });

  it('includes fields when provided', () => {
    const fields = [mrkdwnElement('*field1*'), mrkdwnElement('*field2*')];
    const block = sectionBlock('text', fields);
    expect(block.fields).toEqual(fields);
  });
});

describe('headerBlock', () => {
  it('produces correct shape', () => {
    expect(headerBlock('My Title')).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: 'My Title', emoji: true },
    });
  });
});

describe('contextBlock', () => {
  it('produces correct shape', () => {
    const elements = [mrkdwnElement('_model:_ gpt-4'), mrkdwnElement('_tokens:_ 123')];
    expect(contextBlock(elements)).toEqual({ type: 'context', elements });
  });
});

describe('dividerBlock', () => {
  it('produces correct shape', () => {
    expect(dividerBlock()).toEqual({ type: 'divider' });
  });
});

describe('actionsBlock', () => {
  it('produces correct shape', () => {
    const btn = { type: 'button', text: plainTextElement('Click'), action_id: 'my_btn' };
    expect(actionsBlock([btn])).toEqual({ type: 'actions', elements: [btn] });
  });
});

describe('mrkdwnElement', () => {
  it('produces correct shape', () => {
    expect(mrkdwnElement('*bold*')).toEqual({ type: 'mrkdwn', text: '*bold*' });
  });
});

describe('plainTextElement', () => {
  it('produces correct shape with default emoji true', () => {
    expect(plainTextElement('Click me')).toEqual({
      type: 'plain_text',
      text: 'Click me',
      emoji: true,
    });
  });

  it('respects explicit emoji false', () => {
    expect(plainTextElement('No emoji', false)).toEqual({
      type: 'plain_text',
      text: 'No emoji',
      emoji: false,
    });
  });
});
