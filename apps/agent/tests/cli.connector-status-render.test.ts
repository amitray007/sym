/**
 * Unit tests for the CLI commands:
 *   - src/cli/commands/connector.ts  (connectorCommand + connectorFromAddFlags)
 *   - src/cli/commands/status.ts     (statusCommand)
 *   - src/cli/commands/render.ts     (healthWord, offlineDetails, renderConnectorTable,
 *                                     cliConnectorLines, printReload)
 *
 * ALL dependencies are mocked — no real FS, no real network, no real subprocesses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist vi.mock() calls — they are hoisted to the top by Vitest automatically.
// ---------------------------------------------------------------------------

vi.mock('../src/cli/admin-client.js', () => ({
  applyReload: vi.fn(),
  fetchConnectors: vi.fn(),
  testConnector: vi.fn(),
}));

vi.mock('../src/cli/config-store.js', () => ({
  loadConfigFile: vi.fn(),
  writeConfigFile: vi.fn(),
  upsertConnector: vi.fn(),
  removeConnector: vi.fn(),
  removeCli: vi.fn(),
  setCliAllow: vi.fn(),
  setCliDesc: vi.fn(),
  setConnectorTrust: vi.fn(),
}));

vi.mock('../src/run-cli.js', () => ({
  resolveCliConnectors: vi.fn(),
  isCliWildcard: vi.fn(),
  resolveAllowlist: vi.fn(),
  resolveCliCapabilities: vi.fn(),
}));

vi.mock('@sym/mcp-runtime', () => ({
  configPath: vi.fn(),
  loadCliDescribe: vi.fn(),
  loadCliAllow: vi.fn(),
  parseConnectorArray: vi.fn(),
}));

vi.mock('../src/cli/commands/tools.js', () => ({
  showCommand: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (AFTER vi.mock)
// ---------------------------------------------------------------------------

import { configPath, loadCliDescribe } from '@sym/mcp-runtime';

import { applyReload, fetchConnectors, testConnector } from '../src/cli/admin-client.js';
import { connectorCommand, connectorFromAddFlags } from '../src/cli/commands/connector.js';
import {
  cliConnectorLines,
  healthWord,
  offlineDetails,
  printReload,
  renderConnectorTable,
} from '../src/cli/commands/render.js';
import { statusCommand } from '../src/cli/commands/status.js';
import { showCommand } from '../src/cli/commands/tools.js';
import {
  loadConfigFile,
  removeConnector,
  removeCli,
  setCliAllow,
  setCliDesc,
  setConnectorTrust,
  upsertConnector,
  writeConfigFile,
} from '../src/cli/config-store.js';
import {
  isCliWildcard,
  resolveAllowlist,
  resolveCliCapabilities,
  resolveCliConnectors,
} from '../src/run-cli.js';

import type { ConnectorDetail, ReloadResponse } from '../src/cli/admin-client.js';
import type { SymConfigFile } from '../src/cli/config-store.js';

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockFetchConnectors = vi.mocked(fetchConnectors);
const mockApplyReload = vi.mocked(applyReload);
const mockTestConnector = vi.mocked(testConnector);
const mockLoadConfigFile = vi.mocked(loadConfigFile);
const mockWriteConfigFile = vi.mocked(writeConfigFile);
const mockUpsertConnector = vi.mocked(upsertConnector);
const mockRemoveConnector = vi.mocked(removeConnector);
const mockRemoveCli = vi.mocked(removeCli);
const mockSetCliAllow = vi.mocked(setCliAllow);
const mockSetCliDesc = vi.mocked(setCliDesc);
const mockSetConnectorTrust = vi.mocked(setConnectorTrust);
const mockResolveCliConnectors = vi.mocked(resolveCliConnectors);
const mockIsCliWildcard = vi.mocked(isCliWildcard);
const mockResolveAllowlist = vi.mocked(resolveAllowlist);
const mockResolveCliCapabilities = vi.mocked(resolveCliCapabilities);
const mockConfigPath = vi.mocked(configPath);
const mockLoadCliDescribe = vi.mocked(loadCliDescribe);
const mockShowCommand = vi.mocked(showCommand);

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeConfig(partial: Partial<SymConfigFile> = {}): SymConfigFile {
  return {
    version: 1,
    mcpServers: [],
    ...partial,
  };
}

function makeConnectorDetail(partial: Partial<ConnectorDetail> = {}): ConnectorDetail {
  return {
    name: 'test-connector',
    transport: 'stdio',
    auth: 'none',
    trust: false,
    ok: true,
    tools: 3,
    ...partial,
  };
}

function makeReloadResponse(partial: Partial<ReloadResponse> = {}): ReloadResponse {
  return {
    source: 'file',
    path: '/data/sym/config.json',
    totalTools: 5,
    connectors: [{ name: 'github', status: 'connected', tools: 3 }],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let log: ReturnType<typeof vi.spyOn>;
let logError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  logError = vi.spyOn(console, 'error').mockImplementation(() => {});

  // Reasonable defaults
  mockConfigPath.mockReturnValue('/sym/config.json');
  mockIsCliWildcard.mockReturnValue(false);
  mockResolveCliConnectors.mockReturnValue([]);
  mockLoadCliDescribe.mockReturnValue({});
  mockResolveAllowlist.mockReturnValue(new Set<string>());
  mockResolveCliCapabilities.mockReturnValue([]);
  mockLoadConfigFile.mockReturnValue(makeConfig());
  mockUpsertConnector.mockImplementation((cfg, conn) => ({
    ...cfg,
    mcpServers: [...cfg.mcpServers, conn],
  }));
  mockRemoveConnector.mockReturnValue({ next: makeConfig(), removed: true });
  mockRemoveCli.mockReturnValue({ next: makeConfig(), removed: [] });
  mockSetCliAllow.mockImplementation((cfg, allow) => ({ ...cfg, cli: { allow } }));
  mockSetCliDesc.mockImplementation((cfg, bin, desc) => ({
    ...cfg,
    cli: { allow: cfg.cli?.allow ?? [], describe: { [bin]: desc } },
  }));
  mockSetConnectorTrust.mockImplementation((cfg, _name, _value) => cfg);
  mockWriteConfigFile.mockImplementation(() => {});
  mockApplyReload.mockResolvedValue(makeReloadResponse());
  mockFetchConnectors.mockResolvedValue([]);
  mockTestConnector.mockResolvedValue({
    status: { status: 'connected' },
    tools: [],
  } as any);
  mockShowCommand.mockResolvedValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// render.ts — pure helpers
// ===========================================================================

describe('healthWord', () => {
  it('returns "connected" when ok=true', () => {
    expect(healthWord({ ok: true })).toBe('connected');
  });

  it('returns "failed" when ok=false with an error', () => {
    expect(healthWord({ ok: false, error: 'ECONNREFUSED' })).toBe('failed');
  });

  it('returns "down" when ok=false and no error', () => {
    expect(healthWord({ ok: false })).toBe('down');
  });
});

describe('offlineDetails', () => {
  it('maps mcpServers to ConnectorDetail (offline view)', () => {
    mockLoadConfigFile.mockReturnValue(
      makeConfig({
        mcpServers: [
          {
            name: 'sentry',
            transport: { kind: 'http', url: 'https://example.com' },
            trust: true,
          },
        ],
      }),
    );
    const result = offlineDetails();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'sentry',
      transport: 'http',
      auth: 'none',
      trust: true,
      ok: false,
      tools: 0,
    });
  });

  it('returns empty array when no mcpServers', () => {
    mockLoadConfigFile.mockReturnValue(makeConfig({ mcpServers: [] }));
    expect(offlineDetails()).toEqual([]);
  });

  it('picks up auth.kind when present', () => {
    mockLoadConfigFile.mockReturnValue(
      makeConfig({
        mcpServers: [
          {
            name: 'linear',
            transport: { kind: 'stdio', command: 'linear-mcp' },
            auth: { kind: 'static', secret: 'tok', inject: { at: 'env', name: 'X' } },
          },
        ],
      }),
    );
    const [detail] = offlineDetails();
    expect(detail!.auth).toBe('static');
  });
});

describe('renderConnectorTable', () => {
  it('returns the "no connectors" placeholder for an empty list', () => {
    expect(renderConnectorTable([])).toBe('  (no connectors)');
  });

  it('renders a header + rows for one connector', () => {
    const detail = makeConnectorDetail({ name: 'gh', transport: 'stdio', auth: 'none', tools: 2 });
    const table = renderConnectorTable([detail]);
    expect(table).toContain('NAME');
    expect(table).toContain('TRANSPORT');
    expect(table).toContain('AUTH');
    expect(table).toContain('TRUST');
    expect(table).toContain('HEALTH');
    expect(table).toContain('gh');
    expect(table).toContain('connected');
    expect(table).toContain('2');
  });

  it('includes error line when connector has error', () => {
    const detail = makeConnectorDetail({ ok: false, error: 'ECONNREFUSED', tools: 0 });
    const table = renderConnectorTable([detail]);
    expect(table).toContain('⚠');
    expect(table).toContain('ECONNREFUSED');
  });

  it('shows trust=yes for trusted connectors', () => {
    const detail = makeConnectorDetail({ trust: true });
    expect(renderConnectorTable([detail])).toContain('yes');
  });

  it('shows trust=no for untrusted connectors', () => {
    const detail = makeConnectorDetail({ trust: false });
    expect(renderConnectorTable([detail])).toContain('no');
  });
});

describe('cliConnectorLines', () => {
  it('shows (no CLI connectors) when empty and not wildcard', () => {
    mockResolveCliConnectors.mockReturnValue([]);
    mockIsCliWildcard.mockReturnValue(false);
    const lines = cliConnectorLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no CLI connectors');
  });

  it('renders each CLI connector with onPath=true', () => {
    mockResolveCliConnectors.mockReturnValue([
      { bin: 'gcloud', onPath: true, description: 'Google Cloud CLI' },
    ]);
    mockIsCliWildcard.mockReturnValue(false);
    const lines = cliConnectorLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('gcloud');
    expect(lines[0]).toContain('✓');
    expect(lines[0]).toContain('Google Cloud CLI');
  });

  it('renders each CLI connector with onPath=false', () => {
    mockResolveCliConnectors.mockReturnValue([{ bin: 'missing-bin', onPath: false }]);
    mockIsCliWildcard.mockReturnValue(false);
    const lines = cliConnectorLines();
    expect(lines[0]).toContain('✗ (not on PATH)');
  });

  it('appends wildcard notice when isCliWildcard is true', () => {
    mockResolveCliConnectors.mockReturnValue([]);
    mockIsCliWildcard.mockReturnValue(true);
    const lines = cliConnectorLines();
    expect(lines.some((l) => l.includes('*'))).toBe(true);
  });

  it('shows description when present, omits it when absent', () => {
    mockResolveCliConnectors.mockReturnValue([{ bin: 'jq', onPath: true }]);
    mockIsCliWildcard.mockReturnValue(false);
    const lines = cliConnectorLines();
    // No description → no " — " separator
    expect(lines[0]).not.toContain(' — ');
  });
});

describe('printReload', () => {
  it('emits JSON when json=true', () => {
    const r = makeReloadResponse();
    printReload(r, true);
    expect(log).toHaveBeenCalledOnce();
    const out = JSON.parse(log.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(out['source']).toBe('file');
    expect(out['totalTools']).toBe(5);
  });

  it('emits text output when json=false', () => {
    const r = makeReloadResponse();
    printReload(r, false);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('source: file');
    expect(allOutput).toContain('MCP connectors:');
    expect(allOutput).toContain('github');
  });

  it('renders (none) line when connectors array is empty', () => {
    const r = makeReloadResponse({ connectors: [] });
    printReload(r, false);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('(none)');
  });

  it('renders connector error in text mode', () => {
    const r = makeReloadResponse({
      connectors: [{ name: 'broken', status: 'failed', tools: 0, error: 'timeout' }],
    });
    printReload(r, false);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('broken');
    expect(allOutput).toContain('timeout');
  });

  it('includes CLI connector lines in text mode', () => {
    mockResolveCliConnectors.mockReturnValue([{ bin: 'gcloud', onPath: true }]);
    const r = makeReloadResponse({ connectors: [] });
    printReload(r, false);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('CLIs (run_cli):');
    expect(allOutput).toContain('gcloud');
  });
});

// ===========================================================================
// status.ts
// ===========================================================================

describe('statusCommand', () => {
  describe('reachable agent', () => {
    beforeEach(() => {
      mockFetchConnectors.mockResolvedValue([makeConnectorDetail({ name: 'echo', tools: 4 })]);
    });

    it('json=true: emits JSON with reachable=true', async () => {
      const code = await statusCommand(true);
      expect(code).toBe(0);
      expect(log).toHaveBeenCalledOnce();
      const out = JSON.parse(log.mock.calls[0][0] as string) as Record<string, unknown>;
      expect(out['reachable']).toBe(true);
      expect(out['totalTools']).toBe(4);
      expect(out['connectorCount']).toBe(1);
      expect(Array.isArray(out['connectors'])).toBe(true);
    });

    it('json=false: emits text with "agent: up"', async () => {
      const code = await statusCommand(false);
      expect(code).toBe(0);
      const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
      expect(allOutput).toContain('agent: up');
      expect(allOutput).toContain('4 tool(s)');
    });

    it('json=false: includes configPath in text output', async () => {
      const code = await statusCommand(false);
      expect(code).toBe(0);
      const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
      expect(allOutput).toContain('/sym/config.json');
    });

    it('json=false: renders the connector table', async () => {
      const code = await statusCommand(false);
      expect(code).toBe(0);
      const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
      expect(allOutput).toContain('NAME');
      expect(allOutput).toContain('echo');
    });
  });

  describe('offline agent', () => {
    beforeEach(() => {
      mockFetchConnectors.mockRejectedValue(new Error('ECONNREFUSED'));
      // offlineDetails() reads from loadConfigFile, make sure it has connectors
      mockLoadConfigFile.mockReturnValue(
        makeConfig({
          mcpServers: [{ name: 'sentry', transport: { kind: 'stdio', command: 'sentry-mcp' } }],
        }),
      );
    });

    it('json=true: emits JSON with reachable=false', async () => {
      const code = await statusCommand(true);
      expect(code).toBe(0);
      const out = JSON.parse(log.mock.calls[0][0] as string) as Record<string, unknown>;
      expect(out['reachable']).toBe(false);
    });

    it('json=false: emits text with "agent: down"', async () => {
      const code = await statusCommand(false);
      expect(code).toBe(0);
      const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
      expect(allOutput).toContain('agent: down');
      expect(allOutput).toContain('offline view');
    });

    it('json=false: still renders CLI connector lines', async () => {
      mockResolveCliConnectors.mockReturnValue([{ bin: 'gh', onPath: true }]);
      await statusCommand(false);
      const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
      expect(allOutput).toContain('CLIs (run_cli):');
    });
  });

  describe('json status: includes cli connectors + wildcard flag', () => {
    it('includes cli field with connectors + wildcard', async () => {
      mockFetchConnectors.mockResolvedValue([]);
      mockResolveCliConnectors.mockReturnValue([{ bin: 'jq', onPath: true }]);
      mockIsCliWildcard.mockReturnValue(true);
      await statusCommand(true);
      const out = JSON.parse(log.mock.calls[0][0] as string) as any;
      expect(out.cli.wildcard).toBe(true);
      expect(Array.isArray(out.cli.connectors)).toBe(true);
    });
  });
});

// ===========================================================================
// connectorFromAddFlags (already partially tested in cli.index.test.ts;
// we cover the branches not yet tested)
// ===========================================================================

describe('connectorFromAddFlags', () => {
  it('parses a --spec JSON string', () => {
    const spec = JSON.stringify({
      name: 'linear',
      transport: { kind: 'http', url: 'https://linear.app/mcp' },
    });
    const c = connectorFromAddFlags({ json: spec });
    expect(c.name).toBe('linear');
    expect(c.transport.kind).toBe('http');
  });

  it('throws when --spec JSON has empty name', () => {
    expect(() =>
      connectorFromAddFlags({
        json: JSON.stringify({ name: '', transport: { kind: 'stdio', command: 'x' } }),
      }),
    ).toThrow(/name/);
  });

  it('throws when --spec JSON has no name field', () => {
    expect(() =>
      connectorFromAddFlags({
        json: JSON.stringify({ transport: { kind: 'stdio', command: 'x' } }),
      }),
    ).toThrow(/name/);
  });

  it('builds stdio connector with args', () => {
    const c = connectorFromAddFlags({ name: 'my-server', command: 'node', arg: ['server.js'] });
    expect(c.transport).toEqual({ kind: 'stdio', command: 'node', args: ['server.js'] });
  });

  it('builds stdio connector without args when arg is empty', () => {
    const c = connectorFromAddFlags({ name: 'my-server', command: 'node', arg: [] });
    expect(c.transport).toEqual({ kind: 'stdio', command: 'node' });
  });

  it('builds http connector', () => {
    const c = connectorFromAddFlags({ name: 'remote', url: 'https://example.com' });
    expect(c.transport).toEqual({ kind: 'http', url: 'https://example.com' });
  });

  it('includes trust=true when specified', () => {
    const c = connectorFromAddFlags({
      name: 'trusted',
      url: 'https://trusted.example',
      trust: true,
    });
    expect(c.trust).toBe(true);
  });

  it('does not include trust when not specified', () => {
    const c = connectorFromAddFlags({ name: 'x', url: 'https://x.example' });
    expect(c).not.toHaveProperty('trust');
  });

  it('throws when no name given (no --spec)', () => {
    expect(() => connectorFromAddFlags({ command: 'foo' })).toThrow(/--name/);
  });

  it('throws when no transport flag given', () => {
    expect(() => connectorFromAddFlags({ name: 'x' })).toThrow(
      /--command.*--url|--url.*--command|--spec/i,
    );
  });
});

// ===========================================================================
// connectorCommand — ls / list
// ===========================================================================

describe('connectorCommand: ls / list', () => {
  describe('json=true', () => {
    it('emits connectors + cliWildcard JSON', async () => {
      mockFetchConnectors.mockResolvedValue([
        makeConnectorDetail({ name: 'echo', ok: true, tools: 2 }),
      ]);
      mockLoadConfigFile.mockReturnValue(
        makeConfig({
          mcpServers: [{ name: 'echo', transport: { kind: 'stdio', command: 'node' } }],
        }),
      );
      const code = await connectorCommand(['ls'], true);
      expect(code).toBe(0);
      const out = JSON.parse(log.mock.calls[0][0] as string) as any;
      expect(out.cliWildcard).toBe(false);
      const echo = (out.connectors as any[]).find((c: any) => c.name === 'echo');
      expect(echo?.kind).toBe('mcp');
      expect(echo?.health).toBe('connected');
    });

    it('health is "unknown" for connectors not in live list', async () => {
      mockFetchConnectors.mockResolvedValue([]);
      mockLoadConfigFile.mockReturnValue(
        makeConfig({
          mcpServers: [
            { name: 'ghost', transport: { kind: 'http', url: 'https://ghost.example' } },
          ],
        }),
      );
      const code = await connectorCommand(['ls'], true);
      expect(code).toBe(0);
      const out = JSON.parse(log.mock.calls[0][0] as string) as any;
      expect(out.connectors[0].health).toBe('unknown');
    });

    it('includes cli connectors in json output', async () => {
      mockFetchConnectors.mockResolvedValue([]);
      mockResolveCliConnectors.mockReturnValue([
        { bin: 'gcloud', onPath: true, description: 'GCP CLI' },
      ]);
      const code = await connectorCommand(['list'], true);
      expect(code).toBe(0);
      const out = JSON.parse(log.mock.calls[0][0] as string) as any;
      const cli = (out.connectors as any[]).find((c: any) => c.kind === 'cli');
      expect(cli?.name).toBe('gcloud');
    });
  });

  describe('json=false (text)', () => {
    it('prints header with config path', async () => {
      const code = await connectorCommand(['ls'], false);
      expect(code).toBe(0);
      const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
      expect(allOutput).toContain('/sym/config.json');
    });

    it('shows (none) when no connectors at all and not wildcard', async () => {
      const code = await connectorCommand(['ls'], false);
      expect(code).toBe(0);
      const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
      expect(allOutput).toContain('(none)');
    });

    it('renders mcp connector row', async () => {
      mockFetchConnectors.mockResolvedValue([
        makeConnectorDetail({ name: 'sentry', ok: true, tools: 7 }),
      ]);
      mockLoadConfigFile.mockReturnValue(
        makeConfig({
          mcpServers: [{ name: 'sentry', transport: { kind: 'stdio', command: 'sentry-mcp' } }],
        }),
      );
      const code = await connectorCommand(['ls'], false);
      expect(code).toBe(0);
      const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
      expect(allOutput).toContain('sentry');
      expect(allOutput).toContain('mcp');
      expect(allOutput).toContain('7 tool(s)');
    });

    it('renders connector error line when error is present', async () => {
      mockFetchConnectors.mockResolvedValue([
        makeConnectorDetail({ name: 'broken', ok: false, error: 'TIMEOUT', tools: 0 }),
      ]);
      mockLoadConfigFile.mockReturnValue(
        makeConfig({
          mcpServers: [{ name: 'broken', transport: { kind: 'stdio', command: 'broken-mcp' } }],
        }),
      );
      await connectorCommand(['ls'], false);
      const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
      expect(allOutput).toContain('⚠');
      expect(allOutput).toContain('TIMEOUT');
    });

    it('renders CLI connector row with onPath=true', async () => {
      mockResolveCliConnectors.mockReturnValue([{ bin: 'gh', onPath: true }]);
      await connectorCommand(['ls'], false);
      const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
      expect(allOutput).toContain('gh');
      expect(allOutput).toContain('✓');
    });

    it('renders CLI connector row with onPath=false', async () => {
      mockResolveCliConnectors.mockReturnValue([{ bin: 'missing', onPath: false }]);
      await connectorCommand(['ls'], false);
      const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
      expect(allOutput).toContain('✗');
    });

    it('renders CLI connector description when present', async () => {
      mockResolveCliConnectors.mockReturnValue([
        { bin: 'gcloud', onPath: true, description: 'GCP tooling' },
      ]);
      await connectorCommand(['ls'], false);
      const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
      expect(allOutput).toContain('GCP tooling');
    });

    it('shows wildcard notice when isCliWildcard=true', async () => {
      mockIsCliWildcard.mockReturnValue(true);
      await connectorCommand(['ls'], false);
      const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
      expect(allOutput).toContain('ANY other installed CLI');
    });

    it('agent down still shows wiring-only view', async () => {
      mockFetchConnectors.mockRejectedValue(new Error('ECONNREFUSED'));
      mockLoadConfigFile.mockReturnValue(
        makeConfig({
          mcpServers: [
            { name: 'offline-connector', transport: { kind: 'http', url: 'https://x.example' } },
          ],
        }),
      );
      const code = await connectorCommand(['ls'], false);
      expect(code).toBe(0);
      const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
      expect(allOutput).toContain('offline-connector');
      // health should be 'unknown' since agent is down
      expect(allOutput).toContain('unknown');
    });
  });

  it('verb=undefined defaults to ls behaviour', async () => {
    const code = await connectorCommand([], false);
    expect(code).toBe(0);
  });
});

// ===========================================================================
// connectorCommand — show
// ===========================================================================

describe('connectorCommand: show', () => {
  it('throws when no name given', async () => {
    await expect(connectorCommand(['show'], false)).rejects.toThrow(/requires a name/);
  });

  it('delegates to showCommand for known MCP connector', async () => {
    mockLoadConfigFile.mockReturnValue(
      makeConfig({
        mcpServers: [{ name: 'echo', transport: { kind: 'stdio', command: 'node' } }],
      }),
    );
    mockShowCommand.mockResolvedValue(0);
    const code = await connectorCommand(['show', 'echo'], false);
    expect(mockShowCommand).toHaveBeenCalledWith('echo', false);
    expect(code).toBe(0);
  });

  it('shows CLI connector in text mode when in allowlist', async () => {
    mockLoadConfigFile.mockReturnValue(makeConfig({ mcpServers: [] }));
    mockResolveAllowlist.mockReturnValue(new Set(['gcloud']));
    mockLoadCliDescribe.mockReturnValue({ gcloud: 'Google Cloud CLI' });
    const code = await connectorCommand(['show', 'gcloud'], false);
    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('gcloud');
    expect(allOutput).toContain('Google Cloud CLI');
  });

  it('shows CLI connector in json mode', async () => {
    mockLoadConfigFile.mockReturnValue(makeConfig({ mcpServers: [] }));
    mockResolveAllowlist.mockReturnValue(new Set(['gcloud']));
    mockLoadCliDescribe.mockReturnValue({ gcloud: 'GCP' });
    const code = await connectorCommand(['show', 'gcloud'], true);
    expect(code).toBe(0);
    const out = JSON.parse(log.mock.calls[0][0] as string) as any;
    expect(out.name).toBe('gcloud');
    expect(out.kind).toBe('cli');
    expect(out.description).toBe('GCP');
  });

  it('shows CLI connector with null description when not described', async () => {
    mockLoadConfigFile.mockReturnValue(makeConfig({ mcpServers: [] }));
    mockResolveAllowlist.mockReturnValue(new Set(['jq']));
    mockLoadCliDescribe.mockReturnValue({});
    const code = await connectorCommand(['show', 'jq'], true);
    expect(code).toBe(0);
    const out = JSON.parse(log.mock.calls[0][0] as string) as any;
    expect(out.description).toBeNull();
  });

  it('returns 1 for unknown connector', async () => {
    mockLoadConfigFile.mockReturnValue(makeConfig({ mcpServers: [] }));
    mockResolveAllowlist.mockReturnValue(new Set<string>());
    const code = await connectorCommand(['show', 'unknown-thing'], false);
    expect(code).toBe(1);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain("no connector named 'unknown-thing'");
  });

  it('shows CLI connector under wildcard allowlist via resolveCliCapabilities', async () => {
    mockLoadConfigFile.mockReturnValue(makeConfig({ mcpServers: [] }));
    mockResolveAllowlist.mockReturnValue('*');
    mockResolveCliCapabilities.mockReturnValue([{ bin: 'sentry-cli', description: 'Sentry CLI' }]);
    mockLoadCliDescribe.mockReturnValue({ 'sentry-cli': 'Sentry CLI' });
    const code = await connectorCommand(['show', 'sentry-cli'], false);
    expect(code).toBe(0);
  });
});

// ===========================================================================
// connectorCommand — add
// ===========================================================================

describe('connectorCommand: add (MCP)', () => {
  it('adds a stdio connector and applies reload', async () => {
    mockApplyReload.mockResolvedValue(makeReloadResponse());
    const code = await connectorCommand(
      ['add', '--name', 'my-server', '--command', 'my-mcp'],
      false,
    );
    expect(code).toBe(0);
    expect(mockWriteConfigFile).toHaveBeenCalledOnce();
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('added mcp connector: my-server');
  });

  it('adds a http connector with --url', async () => {
    const code = await connectorCommand(
      ['add', '--name', 'remote-mcp', '--url', 'https://mcp.example.com'],
      false,
    );
    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('added mcp connector: remote-mcp');
  });

  it('adds an http connector with trust flag', async () => {
    const code = await connectorCommand(
      ['add', '--name', 'trusted-mcp', '--url', 'https://trusted.example', '--trust'],
      false,
    );
    expect(code).toBe(0);
  });

  it('soft-note when apply fails (agent down)', async () => {
    mockApplyReload.mockRejectedValue(new Error('ECONNREFUSED'));
    const code = await connectorCommand(['add', '--name', 'srv', '--command', 'srv-mcp'], false);
    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('not applied');
  });

  it('emits json reload when apply succeeds in json mode', async () => {
    mockApplyReload.mockResolvedValue(makeReloadResponse());
    await connectorCommand(['add', '--name', 'srv2', '--command', 'srv2-mcp'], true);
    // JSON from printReload should be in the log calls
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    // At minimum, the add message should be there
    expect(allOutput).toContain('added mcp connector: srv2');
  });
});

describe('connectorCommand: add --cli', () => {
  it('adds a cli connector without desc', async () => {
    mockLoadConfigFile.mockReturnValue(makeConfig({ mcpServers: [], cli: { allow: [] } }));
    const returnedCfg = { version: 1 as const, mcpServers: [], cli: { allow: ['mybin'] } };
    mockSetCliAllow.mockReturnValue(returnedCfg);
    const code = await connectorCommand(['add', '--cli', 'mybin'], false);
    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('added cli connector: mybin');
  });

  it('adds a cli connector with --desc', async () => {
    mockLoadConfigFile.mockReturnValue(makeConfig({ mcpServers: [], cli: { allow: [] } }));
    const afterAllow = { version: 1 as const, mcpServers: [], cli: { allow: ['mybin'] } };
    const afterDesc = {
      version: 1 as const,
      mcpServers: [],
      cli: { allow: ['mybin'], describe: { mybin: 'My bin does stuff' } },
    };
    mockSetCliAllow.mockReturnValue(afterAllow);
    mockSetCliDesc.mockReturnValue(afterDesc);
    const code = await connectorCommand(
      ['add', '--cli', 'mybin', '--desc', 'My bin does stuff'],
      false,
    );
    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('My bin does stuff');
  });

  it('strips wildcard from existing allow before adding', async () => {
    mockLoadConfigFile.mockReturnValue(
      makeConfig({ mcpServers: [], cli: { allow: ['*', 'other'] } }),
    );
    mockSetCliAllow.mockReturnValue({
      version: 1,
      mcpServers: [],
      cli: { allow: ['other', 'mybin'] },
    });
    await connectorCommand(['add', '--cli', 'mybin'], false);
    // setCliAllow should have been called without '*' in the base list
    const callArgs = mockSetCliAllow.mock.calls[0];
    expect(callArgs![1]).not.toContain('*');
  });

  it('throws when no binary specified for --cli', async () => {
    await expect(connectorCommand(['add', '--cli'], false)).rejects.toThrow(/binary/);
  });
});

// ===========================================================================
// connectorCommand — rm / remove
// ===========================================================================

describe('connectorCommand: rm', () => {
  it('throws when no name given', async () => {
    await expect(connectorCommand(['rm'], false)).rejects.toThrow(/requires a name/);
  });

  it('removes an MCP connector and applies reload', async () => {
    mockLoadConfigFile.mockReturnValue(
      makeConfig({
        mcpServers: [{ name: 'echo', transport: { kind: 'stdio', command: 'node' } }],
      }),
    );
    mockRemoveConnector.mockReturnValue({ next: makeConfig(), removed: true });
    const code = await connectorCommand(['rm', 'echo'], false);
    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('removed mcp connector: echo');
  });

  it('removes a CLI connector', async () => {
    mockLoadConfigFile.mockReturnValue(makeConfig({ mcpServers: [] }));
    mockRemoveCli.mockReturnValue({ next: makeConfig(), removed: ['gcloud'] });
    const code = await connectorCommand(['remove', 'gcloud'], false);
    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('removed cli connector: gcloud');
  });

  it('returns 1 when connector not found', async () => {
    mockLoadConfigFile.mockReturnValue(makeConfig({ mcpServers: [] }));
    mockRemoveCli.mockReturnValue({ next: makeConfig(), removed: [] });
    const code = await connectorCommand(['rm', 'nonexistent'], false);
    expect(code).toBe(1);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain("no connector named 'nonexistent'");
  });

  it('soft-note when apply fails after MCP remove', async () => {
    mockLoadConfigFile.mockReturnValue(
      makeConfig({
        mcpServers: [{ name: 'echo', transport: { kind: 'stdio', command: 'node' } }],
      }),
    );
    mockRemoveConnector.mockReturnValue({ next: makeConfig(), removed: true });
    mockApplyReload.mockRejectedValue(new Error('agent down'));
    const code = await connectorCommand(['rm', 'echo'], false);
    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('not applied');
  });
});

// ===========================================================================
// connectorCommand — reconnect / test
// ===========================================================================

describe('connectorCommand: reconnect / test', () => {
  it('throws when no name given', async () => {
    await expect(connectorCommand(['reconnect'], false)).rejects.toThrow(/requires a name/);
  });

  it('returns 1 when agent is unreachable', async () => {
    mockTestConnector.mockRejectedValue(new Error('ECONNREFUSED'));
    const code = await connectorCommand(['reconnect', 'echo'], false);
    expect(code).toBe(1);
    expect(logError).toHaveBeenCalledOnce();
  });

  it('emits JSON when json=true and agent responds', async () => {
    mockTestConnector.mockResolvedValue({
      status: { status: 'connected' },
      tools: [{ name: 'get_env' }],
    } as any);
    const code = await connectorCommand(['test', 'echo'], true);
    expect(code).toBe(0);
    const out = JSON.parse(log.mock.calls[0][0] as string) as any;
    expect(out.status.status).toBe('connected');
  });

  it('text output for connected status returns 0', async () => {
    mockTestConnector.mockResolvedValue({
      status: { status: 'connected' },
      tools: [{ name: 't1' }, { name: 't2' }],
    } as any);
    const code = await connectorCommand(['reconnect', 'echo'], false);
    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('echo');
    expect(allOutput).toContain('connected');
    expect(allOutput).toContain('2 tool(s)');
  });

  it('text output for reconnected status returns 0', async () => {
    mockTestConnector.mockResolvedValue({
      status: { status: 'reconnected' },
      tools: [],
    } as any);
    const code = await connectorCommand(['reconnect', 'echo'], false);
    expect(code).toBe(0);
  });

  it('text output for unchanged status returns 0', async () => {
    mockTestConnector.mockResolvedValue({
      status: { status: 'unchanged' },
      tools: [],
    } as any);
    const code = await connectorCommand(['reconnect', 'echo'], false);
    expect(code).toBe(0);
  });

  it('text output for failed status returns 1', async () => {
    mockTestConnector.mockResolvedValue({
      status: { status: 'failed', error: 'ECONNREFUSED' },
      tools: [],
    } as any);
    const code = await connectorCommand(['reconnect', 'echo'], false);
    expect(code).toBe(1);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('ECONNREFUSED');
  });
});

// ===========================================================================
// connectorCommand — trust / untrust
// ===========================================================================

describe('connectorCommand: trust / untrust', () => {
  it('throws when no name and no --all for trust', async () => {
    await expect(connectorCommand(['trust'], false)).rejects.toThrow(/name or --all/);
  });

  it('throws when no name and no --all for untrust', async () => {
    await expect(connectorCommand(['untrust'], false)).rejects.toThrow(/name or --all/);
  });

  it('trusts a single connector by name', async () => {
    mockLoadConfigFile.mockReturnValue(
      makeConfig({
        mcpServers: [{ name: 'echo', transport: { kind: 'stdio', command: 'node' } }],
      }),
    );
    mockSetConnectorTrust.mockImplementation((cfg, _name, _value) => cfg);
    const code = await connectorCommand(['trust', 'echo'], false);
    expect(code).toBe(0);
    expect(mockSetConnectorTrust).toHaveBeenCalledWith(expect.anything(), 'echo', true);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('trusted: echo');
  });

  it('untrusts a single connector by name', async () => {
    mockLoadConfigFile.mockReturnValue(
      makeConfig({
        mcpServers: [{ name: 'echo', transport: { kind: 'stdio', command: 'node' } }],
      }),
    );
    const code = await connectorCommand(['untrust', 'echo'], false);
    expect(code).toBe(0);
    expect(mockSetConnectorTrust).toHaveBeenCalledWith(expect.anything(), 'echo', false);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('untrusted: echo');
  });

  it('trusts all connectors with --all', async () => {
    mockLoadConfigFile.mockReturnValue(
      makeConfig({
        mcpServers: [
          { name: 'echo', transport: { kind: 'stdio', command: 'node' } },
          { name: 'linear', transport: { kind: 'http', url: 'https://linear.app' } },
        ],
      }),
    );
    const code = await connectorCommand(['trust', '--all'], false);
    expect(code).toBe(0);
    expect(mockSetConnectorTrust).toHaveBeenCalledTimes(2);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('trusted:');
  });

  it('returns 1 and shows message when connector not found', async () => {
    mockLoadConfigFile.mockReturnValue(makeConfig({ mcpServers: [] }));
    const code = await connectorCommand(['trust', 'nonexistent'], false);
    expect(code).toBe(1);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain("no MCP connector named 'nonexistent'");
  });

  it('returns 1 with "no MCP connectors configured" when --all but no servers', async () => {
    mockLoadConfigFile.mockReturnValue(makeConfig({ mcpServers: [] }));
    const code = await connectorCommand(['trust', '--all'], false);
    expect(code).toBe(1);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('no MCP connectors configured');
  });

  it('applies reload after trust', async () => {
    mockLoadConfigFile.mockReturnValue(
      makeConfig({
        mcpServers: [{ name: 'echo', transport: { kind: 'stdio', command: 'node' } }],
      }),
    );
    await connectorCommand(['trust', 'echo'], false);
    expect(mockApplyReload).toHaveBeenCalledOnce();
  });

  it('soft-note when apply fails after trust', async () => {
    mockLoadConfigFile.mockReturnValue(
      makeConfig({
        mcpServers: [{ name: 'echo', transport: { kind: 'stdio', command: 'node' } }],
      }),
    );
    mockApplyReload.mockRejectedValue(new Error('agent down'));
    const code = await connectorCommand(['trust', 'echo'], false);
    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('not applied');
  });
});

// ===========================================================================
// connectorCommand — unknown verb
// ===========================================================================

describe('connectorCommand: unknown verb', () => {
  it('throws for an unrecognized verb', async () => {
    await expect(connectorCommand(['banana'], false)).rejects.toThrow(/unknown.*verb.*banana/i);
  });

  it('throws with empty verb when empty string provided', async () => {
    await expect(connectorCommand([''], false)).rejects.toThrow(/unknown.*verb/i);
  });
});

// ===========================================================================
// Edge cases: non-Error objects thrown
// ===========================================================================

describe('non-Error thrown edge cases', () => {
  it('reconnect: handles non-Error rejection gracefully', async () => {
    mockTestConnector.mockRejectedValue('string error, not an Error object');
    const code = await connectorCommand(['reconnect', 'echo'], false);
    expect(code).toBe(1);
    const errOutput = logError.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(errOutput).toContain('string error, not an Error object');
  });

  it('tryApply (via add): handles non-Error rejection in applyReload', async () => {
    mockApplyReload.mockRejectedValue('some string failure');
    const code = await connectorCommand(['add', '--name', 'srv', '--command', 'srv-mcp'], false);
    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('some string failure');
  });

  it('trust --all with no servers shows "no MCP connectors configured"', async () => {
    mockLoadConfigFile.mockReturnValue(makeConfig({ mcpServers: [] }));
    const code = await connectorCommand(['trust', '--all'], false);
    expect(code).toBe(1);
    const allOutput = log.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(allOutput).toContain('no MCP connectors configured');
  });
});
