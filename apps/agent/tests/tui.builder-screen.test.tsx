/**
 * Tests for BuilderScreen — the guided connector builder form.
 *
 * Pure-helper tests use `buildConnectorFromForm` directly (no TextInput wrangling).
 * Integration tests drive the component and assert mock calls.
 *
 * Timing: yieldEffects() lets useInput subscriptions wire up after render
 * before we send key strokes (same pattern as tui.add-screen.test.tsx).
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must come before component import
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
  configPath: () => '/tmp/sym.json',
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { applyReload } from '../src/cli/admin-client.js';
import { writeConfigFile } from '../src/cli/config-store.js';
import { BuilderScreen, buildConnectorFromForm } from '../src/tui/screens/BuilderScreen.js';

import type { BuilderState } from '../src/tui/screens/BuilderScreen.js';

// ---------------------------------------------------------------------------
// Yield helper
// ---------------------------------------------------------------------------

function yieldEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

// ---------------------------------------------------------------------------
// Default state factory — overrides only the fields under test
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<BuilderState> = {}): BuilderState {
  return {
    name: 'my-connector',
    transportKind: 'stdio',
    target: '/usr/bin/mcp-server',
    args: '',
    authKind: 'none',
    secret: '',
    injectAt: 'env',
    injectParam: '',
    injectValueTemplate: '',
    trust: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helper — buildConnectorFromForm
// ---------------------------------------------------------------------------

describe('buildConnectorFromForm (pure)', () => {
  it('builds a stdio+none connector (minimal)', () => {
    const result = buildConnectorFromForm(
      makeState({ name: 'echo', target: '/bin/echo', authKind: 'none' }),
    );
    expect(result).toEqual({
      name: 'echo',
      transport: { kind: 'stdio', command: '/bin/echo' },
    });
  });

  it('builds a stdio+none connector with args', () => {
    const result = buildConnectorFromForm(
      makeState({
        name: 'svr',
        target: '/bin/svr',
        args: '--port 9000 --verbose',
        authKind: 'none',
      }),
    );
    expect(result).toEqual({
      name: 'svr',
      transport: { kind: 'stdio', command: '/bin/svr', args: ['--port', '9000', '--verbose'] },
    });
  });

  it('omits args when whitespace only', () => {
    const result = buildConnectorFromForm(
      makeState({ target: '/bin/svr', args: '   ', authKind: 'none' }),
    );
    const t = result.transport;
    expect(t.kind).toBe('stdio');
    if (t.kind === 'stdio') {
      expect(t.args).toBeUndefined();
    }
  });

  it('builds an http+none connector', () => {
    const result = buildConnectorFromForm(
      makeState({
        name: 'remote',
        transportKind: 'http',
        target: 'https://api.example.com/mcp',
        authKind: 'none',
      }),
    );
    expect(result).toEqual({
      name: 'remote',
      transport: { kind: 'http', url: 'https://api.example.com/mcp' },
    });
  });

  it('builds stdio+static+env-inject connector with secret', () => {
    const result = buildConnectorFromForm(
      makeState({
        authKind: 'static',
        secret: 'sk-abc123',
        injectAt: 'env',
        injectParam: 'API_KEY',
      }),
    );
    expect(result).toEqual({
      name: 'my-connector',
      transport: { kind: 'stdio', command: '/usr/bin/mcp-server' },
      auth: {
        kind: 'static',
        secret: 'sk-abc123',
        inject: { at: 'env', name: 'API_KEY' },
      },
    });
  });

  it('omits secret when empty for static auth', () => {
    const result = buildConnectorFromForm(
      makeState({ authKind: 'static', secret: '', injectAt: 'env', injectParam: 'TOKEN' }),
    );
    expect(result.auth).toEqual({
      kind: 'static',
      inject: { at: 'env', name: 'TOKEN' },
    });
    expect((result.auth as { secret?: unknown } | undefined)?.secret).toBeUndefined();
  });

  it('builds stdio+static+argv-inject connector', () => {
    const result = buildConnectorFromForm(
      makeState({
        authKind: 'static',
        secret: 'tok',
        injectAt: 'argv',
        injectParam: '--token={{secret}}',
      }),
    );
    expect(result.auth).toEqual({
      kind: 'static',
      secret: 'tok',
      inject: { at: 'argv', template: '--token={{secret}}' },
    });
  });

  it('builds http+static+header-inject connector', () => {
    const result = buildConnectorFromForm(
      makeState({
        transportKind: 'http',
        target: 'https://api.example.com/mcp',
        authKind: 'static',
        secret: 'bearer-tok',
        injectAt: 'header',
        injectParam: 'Authorization',
        injectValueTemplate: 'Bearer {{secret}}',
      }),
    );
    expect(result.auth).toEqual({
      kind: 'static',
      secret: 'bearer-tok',
      inject: { at: 'header', name: 'Authorization', valueTemplate: 'Bearer {{secret}}' },
    });
  });

  it('builds stdio+static+file-inject connector', () => {
    const result = buildConnectorFromForm(
      makeState({
        authKind: 'static',
        secret: '',
        injectAt: 'file',
        injectParam: '/tmp/token.txt',
      }),
    );
    expect(result.auth).toEqual({
      kind: 'static',
      inject: { at: 'file', path: '/tmp/token.txt' },
    });
  });

  it('builds oauth connector', () => {
    const result = buildConnectorFromForm(makeState({ authKind: 'oauth' }));
    expect(result.auth).toEqual({ kind: 'oauth' });
  });

  it('builds ambient connector', () => {
    const result = buildConnectorFromForm(makeState({ authKind: 'ambient' }));
    expect(result.auth).toEqual({ kind: 'ambient' });
  });

  it('includes trust: true when set', () => {
    const result = buildConnectorFromForm(makeState({ trust: true }));
    expect(result.trust).toBe(true);
  });

  it('omits trust when false', () => {
    const result = buildConnectorFromForm(makeState({ trust: false }));
    expect(result.trust).toBeUndefined();
  });

  it('omits auth entirely when authKind is none', () => {
    const result = buildConnectorFromForm(makeState({ authKind: 'none' }));
    expect(result.auth).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: onBack via 'b' key
// ---------------------------------------------------------------------------

describe('BuilderScreen — navigation', () => {
  it('calls onBack when "b" is pressed on the name step', async () => {
    const onBack = vi.fn();
    const { stdin, lastFrame } = render(<BuilderScreen onBack={onBack} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('new connector');
    });
    await yieldEffects();

    stdin.write('b');

    await vi.waitFor(() => {
      expect(onBack).toHaveBeenCalled();
    });
  });

  it('calls onBack when Esc is pressed on the name step', async () => {
    const onBack = vi.fn();
    const { stdin, lastFrame } = render(<BuilderScreen onBack={onBack} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('sym · new connector');
    });
    await yieldEffects();

    stdin.write(''); // ESC

    await vi.waitFor(() => {
      expect(onBack).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: title shows edit mode when connector prop is set
// ---------------------------------------------------------------------------

describe('BuilderScreen — edit mode title', () => {
  it('shows "edit <name>" in the title when connector prop is set', async () => {
    const { lastFrame } = render(<BuilderScreen onBack={vi.fn()} connector="my-server" />);

    await vi.waitFor(() => {
      const frame = lastFrame() ?? '';
      expect(frame).toContain('edit my-server');
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: happy-path stdio+none full flow
// ---------------------------------------------------------------------------

describe('BuilderScreen — stdio+none happy path', () => {
  it('calls writeConfigFile with correct connector after full stdio+none flow', async () => {
    vi.mocked(writeConfigFile).mockClear();
    vi.mocked(applyReload).mockClear();

    const { stdin, lastFrame } = render(<BuilderScreen onBack={vi.fn()} />);

    // Step 1: name
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('name:');
    });
    await yieldEffects();
    stdin.write('testsvr');
    stdin.write('\r');

    // Step 2: transportKind → stdio
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('transport:');
    });
    await yieldEffects();
    stdin.write('s');

    // Step 3: command
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('command:');
    });
    await yieldEffects();
    stdin.write('/usr/bin/testsvr');
    stdin.write('\r');

    // Step 4: args
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('args');
    });
    await yieldEffects();
    stdin.write('--flag val');
    stdin.write('\r');

    // Step 5: authKind → none
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('auth:');
    });
    await yieldEffects();
    stdin.write('n');

    // Step 6: trust → no
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('trust');
    });
    await yieldEffects();
    stdin.write('n');

    // Wait for write
    await vi.waitFor(() => {
      expect(writeConfigFile).toHaveBeenCalled();
    });

    const calls = vi.mocked(writeConfigFile).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const [_path, cfg] = calls[0]!;
    const saved = (cfg as { mcpServers: unknown[] }).mcpServers[0];
    expect(saved).toEqual({
      name: 'testsvr',
      transport: { kind: 'stdio', command: '/usr/bin/testsvr', args: ['--flag', 'val'] },
    });
  });

  it('calls applyReload after writing config', async () => {
    vi.mocked(writeConfigFile).mockClear();
    vi.mocked(applyReload).mockClear();

    const { stdin, lastFrame } = render(<BuilderScreen onBack={vi.fn()} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('name:'));
    await yieldEffects();
    stdin.write('svr2');
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('transport:'));
    await yieldEffects();
    stdin.write('s');

    await vi.waitFor(() => expect(lastFrame()).toContain('command:'));
    await yieldEffects();
    stdin.write('/bin/svr2');
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('args'));
    await yieldEffects();
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('auth:'));
    await yieldEffects();
    stdin.write('n');

    await vi.waitFor(() => expect(lastFrame()).toContain('trust'));
    await yieldEffects();
    stdin.write('n');

    await vi.waitFor(() => {
      expect(applyReload).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: agent-down warning
// ---------------------------------------------------------------------------

describe('BuilderScreen — agent down', () => {
  it('shows warning when applyReload throws', async () => {
    vi.mocked(applyReload).mockRejectedValueOnce(new Error('connection refused'));

    const { stdin, lastFrame } = render(<BuilderScreen onBack={vi.fn()} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('name:'));
    await yieldEffects();
    stdin.write('downsvr');
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('transport:'));
    await yieldEffects();
    stdin.write('s');

    await vi.waitFor(() => expect(lastFrame()).toContain('command:'));
    await yieldEffects();
    stdin.write('/bin/down');
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('args'));
    await yieldEffects();
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('auth:'));
    await yieldEffects();
    stdin.write('n');

    await vi.waitFor(() => expect(lastFrame()).toContain('trust'));
    await yieldEffects();
    stdin.write('n');

    await vi.waitFor(() => {
      const frame = lastFrame() ?? '';
      expect(frame).toContain('saved; not applied');
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: http path skips args step
// ---------------------------------------------------------------------------

describe('BuilderScreen — http path', () => {
  it('skips args step and writes http connector', async () => {
    vi.mocked(writeConfigFile).mockClear();

    const { stdin, lastFrame } = render(<BuilderScreen onBack={vi.fn()} />);

    await vi.waitFor(() => expect(lastFrame()).toContain('name:'));
    await yieldEffects();
    stdin.write('websvr');
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('transport:'));
    await yieldEffects();
    stdin.write('h');

    await vi.waitFor(() => expect(lastFrame()).toContain('url:'));
    await yieldEffects();
    stdin.write('https://mcp.example.com/sse');
    stdin.write('\r');

    // Should go directly to authKind (no args step for http)
    await vi.waitFor(() => expect(lastFrame()).toContain('auth:'));
    await yieldEffects();
    stdin.write('n');

    await vi.waitFor(() => expect(lastFrame()).toContain('trust'));
    await yieldEffects();
    stdin.write('n');

    await vi.waitFor(() => {
      expect(writeConfigFile).toHaveBeenCalled();
    });

    const calls = vi.mocked(writeConfigFile).mock.calls;
    const [_path, cfg] = calls[0]!;
    const saved = (cfg as { mcpServers: unknown[] }).mcpServers[0];
    expect(saved).toEqual({
      name: 'websvr',
      transport: { kind: 'http', url: 'https://mcp.example.com/sse' },
    });
  });
});
