/**
 * TUI root menu — render + cursor navigation.
 *
 * Stays in the menu (does not Enter into a screen) so no screen side effects
 * (network/store) fire. The screens have their own tests.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';

import { App } from '../src/tui/app.js';

// ESC [ B — the terminal "cursor down" sequence ink's useInput parses.
const DOWN_ARROW = `${String.fromCharCode(27)}[B`;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

describe('App menu', () => {
  it('renders the title and all menu items', () => {
    const { lastFrame } = render(<App />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('sym — connector control plane');
    expect(frame).toContain('Status');
    expect(frame).toContain('Add / replace a connector');
    expect(frame).toContain('Secrets');
    expect(frame).toContain('Quit');
  });

  it('starts with the cursor on the first item', () => {
    const { lastFrame } = render(<App />);
    const line = (lastFrame() ?? '').split('\n').find((l) => l.includes('Status')) ?? '';
    expect(line).toContain('❯');
  });

  it('moves the cursor down with the arrow key', async () => {
    const { lastFrame, stdin } = render(<App />);
    await tick();
    stdin.write(DOWN_ARROW);
    await tick();
    const frame = lastFrame() ?? '';
    const addLine = frame.split('\n').find((l) => l.includes('Add / replace')) ?? '';
    expect(addLine).toContain('❯');
  });
});
