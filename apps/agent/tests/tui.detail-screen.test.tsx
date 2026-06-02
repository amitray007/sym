/**
 * DetailScreen — renders connector config + tools table, reacts to keys.
 * admin-client, config-store, and source are mocked; render path is real
 * (ink-testing-library).
 */

import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DetailScreen } from '../src/tui/screens/DetailScreen.js';

vi.mock('../src/cli/admin-client.js', () => ({
  fetchConnectors: vi.fn(),
  fetchConnectorTools: vi.fn(),
  testConnector: vi.fn(),
  applyReload: vi.fn(),
}));
vi.mock('../src/cli/config-store.js', () => ({
  loadConfigFile: vi.fn(() => ({
    version: 1,
    mcpServers: [
      {
        name: 'echo',
        transport: { kind: 'stdio', command: 'echo' },
        trust: true,
      },
    ],
  })),
  removeConnector: vi.fn((cfg: unknown, _name: string) => ({ next: cfg, removed: true })),
  writeConfigFile: vi.fn(),
}));
vi.mock('../src/mcp/source.js', () => ({ configPath: () => '/tmp/x.json' }));

import {
  applyReload,
  fetchConnectors,
  fetchConnectorTools,
  testConnector,
} from '../src/cli/admin-client.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 50));
const noop = (): void => undefined;

const DETAIL = {
  name: 'echo',
  transport: 'stdio',
  auth: 'none',
  trust: true,
  ok: true,
  tools: 2,
};

const TOOLS = [
  { name: 'ping', description: 'send a ping' },
  { name: 'echo', description: 'echo back the input' },
];

describe('DetailScreen', () => {
  beforeEach(() => {
    vi.mocked(fetchConnectors).mockResolvedValue([DETAIL]);
    vi.mocked(fetchConnectorTools).mockResolvedValue(TOOLS);
    vi.mocked(testConnector).mockResolvedValue({
      status: { name: 'echo', status: 'reconnected', tools: 3 },
      tools: [
        { name: 'ping', description: 'send a ping' },
        { name: 'echo', description: 'echo back' },
        { name: 'extra', description: 'extra tool' },
      ],
    });
    vi.mocked(applyReload).mockResolvedValue({
      source: 'file',
      path: '/tmp/x.json',
      connectors: [],
      totalTools: 0,
    });
  });
  afterEach(() => vi.clearAllMocks());

  it('renders tools from the connector', async () => {
    const { lastFrame } = render(<DetailScreen connector="echo" onBack={noop} onEdit={noop} />);
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('ping'));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('echo');
    expect(frame).toContain('send a ping');
  });

  it('calls testConnector on "t" and updates note', async () => {
    const { stdin, lastFrame } = render(
      <DetailScreen connector="echo" onBack={noop} onEdit={noop} />,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('ping'));
    await tick();
    stdin.write('t');
    await vi.waitFor(() => expect(testConnector).toHaveBeenCalledWith('echo'));
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('reconnected'));
  });

  it('calls onEdit with the connector name on "e"', async () => {
    const onEdit = vi.fn();
    const { stdin, lastFrame } = render(
      <DetailScreen connector="echo" onBack={noop} onEdit={onEdit} />,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('ping'));
    await tick();
    stdin.write('e');
    await vi.waitFor(() => expect(onEdit).toHaveBeenCalledWith('echo'));
  });

  it('calls onBack on "b"', async () => {
    const onBack = vi.fn();
    const { stdin, lastFrame } = render(
      <DetailScreen connector="echo" onBack={onBack} onEdit={noop} />,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('ping'));
    await tick();
    stdin.write('b');
    await vi.waitFor(() => expect(onBack).toHaveBeenCalled());
  });

  it('shows "agent not reachable" when agent is down but config loads from disk', async () => {
    vi.mocked(fetchConnectors).mockRejectedValue(new Error('connection refused'));
    vi.mocked(fetchConnectorTools).mockRejectedValue(new Error('connection refused'));
    const { lastFrame } = render(<DetailScreen connector="echo" onBack={noop} onEdit={noop} />);
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('agent not reachable'));
    // config section still renders from disk
    expect(lastFrame() ?? '').toContain('echo');
  });
});
