/**
 * Tests for StatusScreen — the live connector status TUI screen.
 *
 * Mocks: admin-client (fetchStatus + applyReload), config-store (loadConfigFile),
 * mcp/source (configPath). All external I/O is fully faked.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before the imports they replace
// ---------------------------------------------------------------------------

vi.mock('../src/cli/admin-client.js', () => ({
  fetchStatus: vi.fn(),
  applyReload: vi.fn(),
}));

vi.mock('../src/cli/config-store.js', () => ({
  loadConfigFile: vi.fn(),
}));

vi.mock('../src/mcp/source.js', () => ({
  configPath: () => '/tmp/x.json',
}));

// Import the mocked modules and the component under test after vi.mock declarations
import { fetchStatus, applyReload } from '../src/cli/admin-client.js';
import { loadConfigFile } from '../src/cli/config-store.js';
import { StatusScreen } from '../src/tui/screens/StatusScreen.js';

const mockFetchStatus = vi.mocked(fetchStatus);
const mockApplyReload = vi.mocked(applyReload);
const mockLoadConfigFile = vi.mocked(loadConfigFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigFile(connectorNames: string[] = []) {
  return {
    version: 1,
    mcpServers: connectorNames.map((name) => ({
      name,
      transport: { kind: 'stdio' as const, command: `/usr/bin/${name}` },
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StatusScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows connector name and tool count when fetchStatus resolves', async () => {
    mockFetchStatus.mockResolvedValue({ connectors: ['echo'], totalTools: 3 });
    mockLoadConfigFile.mockReturnValue(makeConfigFile(['echo']));

    const { lastFrame } = render(<StatusScreen onBack={vi.fn()} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('echo');
    });

    expect(lastFrame()).toContain('3');
  });

  it('shows not-reachable hint when fetchStatus rejects', async () => {
    mockFetchStatus.mockRejectedValue(
      new Error('could not reach the Sym admin endpoint — is the agent running?'),
    );
    mockLoadConfigFile.mockReturnValue(makeConfigFile([]));

    const { lastFrame } = render(<StatusScreen onBack={vi.fn()} />);

    await vi.waitFor(() => {
      const frame = lastFrame() ?? '';
      expect(
        frame.includes('not reachable') ||
          frame.includes('could not reach') ||
          frame.includes('start Sym'),
      ).toBe(true);
    });
  });

  it('calls applyReload when "a" is pressed', async () => {
    mockFetchStatus.mockResolvedValue({ connectors: ['echo'], totalTools: 3 });
    mockApplyReload.mockResolvedValue({
      connectors: [{ name: 'echo', status: 'unchanged', tools: 3 }],
      totalTools: 3,
      source: 'file',
      path: '/tmp/x.json',
    });
    mockLoadConfigFile.mockReturnValue(makeConfigFile(['echo']));

    const { lastFrame, stdin } = render(<StatusScreen onBack={vi.fn()} />);

    // Wait for initial load to complete
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('echo');
    });
    // Give React time to run useEffect (registers the useInput handler)
    await new Promise((r) => setTimeout(r, 50));

    stdin.write('a');

    await vi.waitFor(() => {
      expect(mockApplyReload).toHaveBeenCalled();
    });
  });

  it('calls onBack when "b" is pressed', async () => {
    mockFetchStatus.mockResolvedValue({ connectors: [], totalTools: 0 });
    mockLoadConfigFile.mockReturnValue(makeConfigFile([]));

    const onBack = vi.fn();
    const { lastFrame, stdin } = render(<StatusScreen onBack={onBack} />);

    // Wait for the component to render its footer AND for useEffect hooks to mount
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('back');
    });
    // Give React time to run useEffect (registers the useInput handler)
    await new Promise((r) => setTimeout(r, 50));

    stdin.write('b');

    await vi.waitFor(() => {
      expect(onBack).toHaveBeenCalled();
    });
  });
});
