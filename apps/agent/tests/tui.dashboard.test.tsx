/**
 * Dashboard — renders the live connector table + reacts to keys. admin-client +
 * config-store + source are mocked; the render path is real (ink-testing-library).
 */

import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Dashboard } from '../src/tui/screens/Dashboard.js';

vi.mock('../src/cli/admin-client.js', () => ({
  fetchConnectors: vi.fn(),
  applyReload: vi.fn(),
  testConnector: vi.fn(),
}));
vi.mock('../src/cli/config-store.js', () => ({
  loadConfigFile: vi.fn(() => ({ version: 1, mcpServers: [] })),
}));
vi.mock('../src/mcp/source.js', () => ({
  configPath: () => '/tmp/x.json',
  loadCliAllow: () => undefined,
  loadCliDescribe: () => ({}),
}));

import { applyReload, fetchConnectors, testConnector } from '../src/cli/admin-client.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 50));
const noop = (): void => undefined;

const HEALTHY = { name: 'echo', transport: 'stdio', auth: 'none', trust: true, ok: true, tools: 2 };
const BROKEN = {
  name: 'sentry',
  transport: 'stdio',
  auth: 'static',
  trust: false,
  ok: false,
  tools: 0,
  error: 'spawn failed',
};

describe('Dashboard', () => {
  beforeEach(() => {
    vi.mocked(fetchConnectors).mockResolvedValue([HEALTHY, BROKEN]);
    vi.mocked(applyReload).mockResolvedValue({
      source: 'file',
      path: '/tmp/x.json',
      connectors: [],
      totalTools: 2,
    });
    vi.mocked(testConnector).mockResolvedValue({
      status: { name: 'echo', status: 'reconnected', tools: 2 },
      tools: [],
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('renders the connector table with health + tool counts', async () => {
    const { lastFrame } = render(
      <Dashboard onOpen={noop} onAdd={noop} onSecrets={noop} onQuit={noop} />,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('echo'));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('connected');
    expect(frame).toContain('sentry');
    expect(frame).toContain('agent up');
    expect(frame).toContain('2 tools live');
  });

  it('opens detail for the selected connector on Enter', async () => {
    const onOpen = vi.fn();
    const { stdin, lastFrame } = render(
      <Dashboard onOpen={onOpen} onAdd={noop} onSecrets={noop} onQuit={noop} />,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('echo'));
    await tick();
    stdin.write('\r');
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('echo'));
  });

  it('applies on "a"', async () => {
    const { stdin, lastFrame } = render(
      <Dashboard onOpen={noop} onAdd={noop} onSecrets={noop} onQuit={noop} />,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('echo'));
    await tick();
    stdin.write('a');
    await vi.waitFor(() => expect(applyReload).toHaveBeenCalled());
  });

  it('opens add on "n" and secrets on "s"', async () => {
    const onAdd = vi.fn();
    const onSecrets = vi.fn();
    const { stdin, lastFrame } = render(
      <Dashboard onOpen={noop} onAdd={onAdd} onSecrets={onSecrets} onQuit={noop} />,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('echo'));
    await tick();
    stdin.write('n');
    await vi.waitFor(() => expect(onAdd).toHaveBeenCalled());
    stdin.write('s');
    await vi.waitFor(() => expect(onSecrets).toHaveBeenCalled());
  });
});
