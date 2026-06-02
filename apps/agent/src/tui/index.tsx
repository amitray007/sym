/**
 * TUI entry — renders the Ink `App` and resolves when the user quits.
 *
 * Imported lazily by the `sym` CLI (cli/index.ts) so the JSX/Ink/React tree is
 * only loaded when the interactive mode is actually launched.
 *
 * NO_COLOR support: if the `NO_COLOR` environment variable is set, Chalk's
 * bundled supports-color probe does not reliably honour it before the first
 * render. We force `FORCE_COLOR=0` before the Ink render so that no colour
 * escape codes are emitted in colour-less terminals (see
 * https://no-color.org for the standard).
 */

// Honour NO_COLOR (https://no-color.org) — must happen before 'ink' is
// imported/rendered because Chalk's supports-color check runs at module load.
if (process.env['NO_COLOR'] !== undefined) {
  process.env['FORCE_COLOR'] = '0';
}

import { render } from 'ink';

import { App } from './app.js';

/** Launch the interactive TUI; resolves when the user exits. */
export async function launchTui(): Promise<void> {
  const { waitUntilExit } = render(<App />);
  await waitUntilExit();
}
