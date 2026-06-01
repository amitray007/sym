/**
 * TUI entry — renders the Ink `App` and resolves when the user quits.
 *
 * Imported lazily by the `sym` CLI (cli/index.ts) so the JSX/Ink/React tree is
 * only loaded when the interactive mode is actually launched.
 */

import { render } from 'ink';
import React from 'react';

import { App } from './app.js';

/** Launch the interactive TUI; resolves when the user exits. */
export async function launchTui(): Promise<void> {
  const { waitUntilExit } = render(<App />);
  await waitUntilExit();
}
