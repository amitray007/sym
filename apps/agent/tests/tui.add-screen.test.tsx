/**
 * Tests for AddScreen — the stepped MCP connector add form.
 *
 * Connector-shape assertions use the exported `buildConnector` pure helper
 * directly (per spec guidance) to avoid fighting TextInput timing.
 * Integration tests drive the full form and assert mock calls.
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must come before the component import
// ---------------------------------------------------------------------------

vi.mock('../src/cli/config-store.js', () => ({
  loadConfigFile: vi.fn(() => ({ version: 1, mcpServers: [] })),
  upsertConnector: vi.fn((c: unknown, x: unknown) => ({
    ...(c as object),
    mcpServers: [x],
  })),
  writeConfigFile: vi.fn(),
}));

vi.mock('../src/cli/admin-client.js', () => ({
  applyReload: vi.fn().mockResolvedValue({
    source: 'file',
    path: '/tmp/x',
    connectors: [],
    totalTools: 0,
  }),
}));

vi.mock('../src/mcp/source.js', () => ({
  configPath: () => '/tmp/x.json',
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { applyReload } from '../src/cli/admin-client.js';
import { writeConfigFile } from '../src/cli/config-store.js';
import { AddScreen, buildConnector } from '../src/tui/screens/AddScreen.js';

// ---------------------------------------------------------------------------
// Yield helper — lets React's passive effects (useInput subscriptions) run
// after a render before we send input. useEffect in ink runs asynchronously
// after commit via scheduler; a setTimeout(0) yield is enough.
// ---------------------------------------------------------------------------

function yieldEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

// ---------------------------------------------------------------------------
// Pure helper tests — no TextInput wrangling needed
// ---------------------------------------------------------------------------

describe('buildConnector (pure)', () => {
  it('builds a stdio connector with args and trust', () => {
    const result = buildConnector({
      name: 'echo',
      kind: 'stdio',
      target: '/usr/bin/echo',
      args: '-n hello',
      trust: true,
    });
    expect(result).toEqual({
      name: 'echo',
      transport: { kind: 'stdio', command: '/usr/bin/echo', args: ['-n', 'hello'] },
      trust: true,
    });
  });

  it('omits args when empty', () => {
    const result = buildConnector({
      name: 'mysvr',
      kind: 'stdio',
      target: '/bin/mysvr',
      args: '   ',
      trust: false,
    });
    expect(result).toEqual({
      name: 'mysvr',
      transport: { kind: 'stdio', command: '/bin/mysvr' },
    });
  });

  it('omits trust when false', () => {
    const result = buildConnector({
      name: 'svr',
      kind: 'stdio',
      target: '/bin/svr',
      args: '',
      trust: false,
    });
    expect(result.trust).toBeUndefined();
  });

  it('builds an http connector', () => {
    const result = buildConnector({
      name: 'remote',
      kind: 'http',
      target: 'https://api.example.com/mcp',
      args: '',
      trust: false,
    });
    expect(result).toEqual({
      name: 'remote',
      transport: { kind: 'http', url: 'https://api.example.com/mcp' },
    });
  });

  it('builds an http connector with trust', () => {
    const result = buildConnector({
      name: 'trusted-remote',
      kind: 'http',
      target: 'https://trusted.example.com/mcp',
      args: '',
      trust: true,
    });
    expect(result).toEqual({
      name: 'trusted-remote',
      transport: { kind: 'http', url: 'https://trusted.example.com/mcp' },
      trust: true,
    });
  });

  it('splits args on multiple whitespace', () => {
    const result = buildConnector({
      name: 'svr',
      kind: 'stdio',
      target: '/bin/svr',
      args: '--port  9000  --verbose',
      trust: false,
    });
    const t = result.transport;
    expect(t.kind).toBe('stdio');
    if (t.kind === 'stdio') {
      expect(t.args).toEqual(['--port', '9000', '--verbose']);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: onBack via 'b' key
// ---------------------------------------------------------------------------

describe('AddScreen — navigation', () => {
  it('calls onBack when "b" is pressed on the name step', async () => {
    const onBack = vi.fn();
    const { stdin, lastFrame } = render(<AddScreen onBack={onBack} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Add MCP Connector');
    });
    await yieldEffects();

    stdin.write('b');

    await vi.waitFor(() => {
      expect(onBack).toHaveBeenCalled();
    });
  });

  it('calls onBack when "b" is pressed on the kind step', async () => {
    const onBack = vi.fn();
    const { stdin, lastFrame } = render(<AddScreen onBack={onBack} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('name:');
    });
    await yieldEffects();

    // Advance to kind step: write name then Enter
    stdin.write('myconn');
    stdin.write('\r');

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('transport kind');
    });
    await yieldEffects();

    stdin.write('b');

    await vi.waitFor(() => {
      expect(onBack).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: happy-path stdio add
//
// Uses refs (not React state) for onSubmit values, so writing a full string
// then '\r' works without waiting for React to commit between writes.
// yieldEffects() before each write lets the useInput subscription wire up.
// ---------------------------------------------------------------------------

describe('AddScreen — stdio happy path', () => {
  it('calls writeConfigFile with the correct connector after full stdio flow', async () => {
    vi.mocked(writeConfigFile).mockClear();
    vi.mocked(applyReload).mockClear();

    const { stdin, lastFrame } = render(<AddScreen onBack={vi.fn()} />);

    // Step 1: name
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('name:');
    });
    await yieldEffects();
    stdin.write('myserver');
    stdin.write('\r');

    // Step 2: kind → stdio
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('transport kind');
    });
    await yieldEffects();
    stdin.write('s');

    // Step 3: command
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('command');
    });
    await yieldEffects();
    stdin.write('/usr/bin/myserver');
    stdin.write('\r');

    // Step 4: args
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('args');
    });
    await yieldEffects();
    stdin.write('--port 9000');
    stdin.write('\r');

    // Step 5: trust → yes
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Trust');
    });
    await yieldEffects();
    stdin.write('y');

    // Wait for writeConfigFile to be called
    await vi.waitFor(() => {
      expect(writeConfigFile).toHaveBeenCalled();
    });

    const calls = vi.mocked(writeConfigFile).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [_path, cfg] = calls[0]!;
    const connector = (cfg as { mcpServers: unknown[] }).mcpServers[0];
    expect(connector).toEqual({
      name: 'myserver',
      transport: { kind: 'stdio', command: '/usr/bin/myserver', args: ['--port', '9000'] },
      trust: true,
    });
  });

  it('calls applyReload after writing config', async () => {
    vi.mocked(writeConfigFile).mockClear();
    vi.mocked(applyReload).mockClear();

    const { stdin, lastFrame } = render(<AddScreen onBack={vi.fn()} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('name:');
    });
    await yieldEffects();
    stdin.write('svr2');
    stdin.write('\r');

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('transport kind');
    });
    await yieldEffects();
    stdin.write('s');

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('command');
    });
    await yieldEffects();
    stdin.write('/bin/svr2');
    stdin.write('\r');

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('args');
    });
    await yieldEffects();
    stdin.write('\r'); // empty args

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Trust');
    });
    await yieldEffects();
    stdin.write('n');

    await vi.waitFor(() => {
      expect(applyReload).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: http path
// ---------------------------------------------------------------------------

describe('AddScreen — http path', () => {
  it('calls writeConfigFile with http connector when kind=h', async () => {
    vi.mocked(writeConfigFile).mockClear();

    const { stdin, lastFrame } = render(<AddScreen onBack={vi.fn()} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('name:');
    });
    await yieldEffects();
    stdin.write('websvr');
    stdin.write('\r');

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('transport kind');
    });
    await yieldEffects();
    stdin.write('h');

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('url');
    });
    await yieldEffects();
    stdin.write('https://mcp.example.com/sse');
    stdin.write('\r');

    // No args step for http
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Trust');
    });
    await yieldEffects();
    stdin.write('n');

    await vi.waitFor(() => {
      expect(writeConfigFile).toHaveBeenCalled();
    });

    const calls = vi.mocked(writeConfigFile).mock.calls;
    const [_path, cfg] = calls[0]!;
    const connector = (cfg as { mcpServers: unknown[] }).mcpServers[0];
    expect(connector).toEqual({
      name: 'websvr',
      transport: { kind: 'http', url: 'https://mcp.example.com/sse' },
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: agent-down warning
// ---------------------------------------------------------------------------

describe('AddScreen — agent down', () => {
  it('shows a warning when applyReload throws', async () => {
    vi.mocked(applyReload).mockRejectedValueOnce(new Error('connection refused'));

    const { lastFrame, stdin } = render(<AddScreen onBack={vi.fn()} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('name:');
    });
    await yieldEffects();
    stdin.write('downsvr');
    stdin.write('\r');

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('transport kind');
    });
    await yieldEffects();
    stdin.write('s');

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('command');
    });
    await yieldEffects();
    stdin.write('/bin/downsvr');
    stdin.write('\r');

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('args');
    });
    await yieldEffects();
    stdin.write('\r');

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Trust');
    });
    await yieldEffects();
    stdin.write('n');

    await vi.waitFor(() => {
      const frame = lastFrame() ?? '';
      expect(frame).toContain('saved; not applied');
    });
  });
});
