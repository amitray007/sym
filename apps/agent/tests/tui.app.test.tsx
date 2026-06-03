/**
 * TUI root router — Dashboard is home; navigating to the builder and back works.
 * Data deps are mocked; the render + navigation path is real.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../src/tui/app.js';

import type * as McpRuntime from '@sym/mcp-runtime';

vi.mock('../src/cli/admin-client.js', () => ({
  fetchConnectors: vi.fn().mockResolvedValue([]),
  fetchConnectorTools: vi.fn().mockResolvedValue([]),
  testConnector: vi.fn(),
  applyReload: vi.fn(),
}));
vi.mock('../src/cli/config-store.js', () => ({
  loadConfigFile: vi.fn(() => ({ version: 1, mcpServers: [] })),
  upsertConnector: vi.fn((c, x) => ({ ...c, mcpServers: [x] })),
  writeConfigFile: vi.fn(),
  removeConnector: vi.fn((c) => ({ next: c, removed: false })),
}));
vi.mock('@sym/mcp-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof McpRuntime>()),
  configPath: () => '/tmp/x.json',
}));

const ESC = String.fromCharCode(27);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

describe('App router', () => {
  it('lands on the Dashboard', async () => {
    const { lastFrame } = render(<App />);
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('sym · connectors'));
  });

  it('navigates Dashboard → new-connector builder on "n", and back on escape', async () => {
    const { lastFrame, stdin } = render(<App />);
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('sym · connectors'));
    await tick();
    stdin.write('n');
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('new connector'));
    await tick();
    stdin.write(ESC); // escape
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('sym · connectors'));
  });

  it('navigates Dashboard → secrets on "s"', async () => {
    const { lastFrame, stdin } = render(<App />);
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('sym · connectors'));
    await tick();
    stdin.write('s');
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('sym · secrets'));
  });
});
