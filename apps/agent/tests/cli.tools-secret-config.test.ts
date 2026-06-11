/**
 * Unit tests for:
 *   - src/cli/commands/tools.ts  (toolsCommand)
 *   - src/cli/commands/secret.ts (secretCommand)
 *   - src/config.ts              (loadAgentConfig)
 *
 * All external I/O is mocked — no real servers, no real filesystem, no network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted (vi.mock is hoisted by Vitest automatically)
// ---------------------------------------------------------------------------

vi.mock('../src/cli/admin-client.js', () => ({
  fetchConnectors: vi.fn(),
  fetchConnectorTools: vi.fn(),
}));

vi.mock('../src/run-cli.js', () => ({
  resolveCliConnectors: vi.fn(),
  isCliWildcard: vi.fn(),
}));

vi.mock('../src/cli/commands/render.js', () => ({
  cliConnectorLines: vi.fn(),
  healthWord: vi.fn(),
}));

vi.mock('../src/cli/config-store.js', () => ({
  loadConfigFile: vi.fn(),
}));

vi.mock('../src/cli/secrets.js', () => ({
  listSecrets: vi.fn(),
  removeSecret: vi.fn(),
  setSecret: vi.fn(),
}));

vi.mock('@sym/mcp-runtime', () => ({
  configPath: vi.fn(() => '/fake/.sym/config.json'),
  loadConnectorConfigs: vi.fn(() => ({ mcpServers: [], source: 'none', path: '' })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { loadConnectorConfigs } from '@sym/mcp-runtime';

import { fetchConnectors, fetchConnectorTools } from '../src/cli/admin-client.js';
import { cliConnectorLines } from '../src/cli/commands/render.js';
import { secretCommand } from '../src/cli/commands/secret.js';
import { toolsCommand, showCommand } from '../src/cli/commands/tools.js';
import { loadConfigFile } from '../src/cli/config-store.js';
import { listSecrets, removeSecret, setSecret } from '../src/cli/secrets.js';
import { loadAgentConfig } from '../src/config.js';
import { resolveCliConnectors, isCliWildcard } from '../src/run-cli.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function spyLog() {
  return vi.spyOn(console, 'log').mockImplementation(() => {});
}

function spyError() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

// ============================================================================
// toolsCommand
// ============================================================================

describe('toolsCommand — named connector', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it('fetches tools for a named connector and prints text output', async () => {
    const log = spyLog();
    vi.mocked(fetchConnectorTools).mockResolvedValue([
      { name: 'create_issue', description: 'Create a GitHub issue' },
      { name: 'list_prs', description: 'List pull requests' },
    ]);

    const code = await toolsCommand('github', false);

    expect(code).toBe(0);
    expect(log.mock.calls[0]?.[0]).toMatch(/github.*2 tool/);
    expect(log.mock.calls[1]?.[0]).toContain('create_issue');
    expect(log.mock.calls[2]?.[0]).toContain('list_prs');
  });

  it('fetches tools for a named connector and prints JSON output', async () => {
    const log = spyLog();
    vi.mocked(fetchConnectorTools).mockResolvedValue([
      { name: 'search', description: 'Search issues' },
    ]);

    const code = await toolsCommand('linear', true);

    expect(code).toBe(0);
    const raw = log.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw) as { connector: string; tools: { name: string }[] };
    expect(parsed.connector).toBe('linear');
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0]?.name).toBe('search');
  });

  it('returns 1 and prints an error when fetchConnectorTools throws (Error)', async () => {
    spyLog();
    const err = spyError();
    vi.mocked(fetchConnectorTools).mockRejectedValue(new Error('connection refused'));

    const code = await toolsCommand('sentry', false);

    expect(code).toBe(1);
    expect(err.mock.calls[0]?.[0]).toContain('connection refused');
  });

  it('returns 1 and prints an error when fetchConnectorTools throws (string)', async () => {
    spyLog();
    const err = spyError();
    vi.mocked(fetchConnectorTools).mockRejectedValue('something went wrong');

    const code = await toolsCommand('sentry', false);

    expect(code).toBe(1);
    expect(err.mock.calls[0]?.[0]).toContain('something went wrong');
  });

  it('prints zero tools correctly', async () => {
    const log = spyLog();
    vi.mocked(fetchConnectorTools).mockResolvedValue([]);

    const code = await toolsCommand('empty-connector', false);

    expect(code).toBe(0);
    expect(log.mock.calls[0]?.[0]).toMatch(/empty-connector.*0 tool/);
  });
});

describe('toolsCommand — all connectors (no name)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('returns 1 with a friendly message when fetchConnectors fails', async () => {
    spyLog();
    const err = spyError();
    vi.mocked(fetchConnectors).mockRejectedValue(new Error('agent offline'));

    const code = await toolsCommand(undefined, false);

    expect(code).toBe(1);
    expect(err.mock.calls[0]?.[0]).toMatch(/agent offline/);
    expect(err.mock.calls[0]?.[0]).toMatch(/start Sym|sym apply/);
  });

  it('prints the full catalog in text mode', async () => {
    const log = spyLog();
    vi.mocked(fetchConnectors).mockResolvedValue([
      { name: 'github', ok: true, transport: 'stdio', auth: 'none', trust: false, tools: 2 },
      { name: 'linear', ok: false, transport: 'stdio', auth: 'none', trust: false, tools: 0 },
    ]);
    // Only github (ok=true) calls fetchConnectorTools; linear (ok=false) returns [] directly.
    vi.mocked(fetchConnectorTools).mockResolvedValueOnce([
      { name: 'create_issue', description: 'Create issue' },
      { name: 'list_prs', description: 'List PRs' },
    ]);
    vi.mocked(resolveCliConnectors).mockReturnValue([]);
    vi.mocked(isCliWildcard).mockReturnValue(false);
    vi.mocked(cliConnectorLines).mockReturnValue(['  gh ✓ — GitHub CLI']);

    const code = await toolsCommand(undefined, false);

    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c) => c[0] as string).join('\n');
    expect(allOutput).toMatch(/2 tool\(s\) across 2 connector/);
    expect(allOutput).toContain('github');
    expect(allOutput).toContain('linear');
    expect(allOutput).toContain('not connected');
    expect(allOutput).toContain('CLIs (via run_cli)');
  });

  it('prints the full catalog in JSON mode', async () => {
    const log = spyLog();
    vi.mocked(fetchConnectors).mockResolvedValue([
      { name: 'github', ok: true, transport: 'stdio', auth: 'none', trust: false, tools: 1 },
    ]);
    vi.mocked(fetchConnectorTools).mockResolvedValue([
      { name: 'create_issue', description: 'Create issue' },
    ]);
    vi.mocked(resolveCliConnectors).mockReturnValue([
      { bin: 'gh', onPath: true, description: 'GitHub CLI' },
    ]);
    vi.mocked(isCliWildcard).mockReturnValue(false);

    const code = await toolsCommand(undefined, true);

    expect(code).toBe(0);
    const raw = log.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw) as {
      catalog: { connector: string; ok: boolean; tools: { name: string }[] }[];
      cli: { connectors: { bin: string }[]; wildcard: boolean; via: string };
    };
    expect(parsed.catalog).toHaveLength(1);
    expect(parsed.catalog[0]?.connector).toBe('github');
    expect(parsed.catalog[0]?.tools).toHaveLength(1);
    expect(parsed.cli.via).toBe('run_cli');
  });

  it('handles a connector where fetchConnectorTools fails gracefully (ok=true, tools→[])', async () => {
    const log = spyLog();
    vi.mocked(fetchConnectors).mockResolvedValue([
      { name: 'flaky', ok: true, transport: 'stdio', auth: 'none', trust: false, tools: 0 },
    ]);
    // The tools fetch throws — should be caught by .catch(() => [])
    vi.mocked(fetchConnectorTools).mockRejectedValue(new Error('timeout'));
    vi.mocked(resolveCliConnectors).mockReturnValue([]);
    vi.mocked(isCliWildcard).mockReturnValue(false);
    vi.mocked(cliConnectorLines).mockReturnValue([]);

    const code = await toolsCommand(undefined, false);

    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c) => c[0] as string).join('\n');
    // 0 tools total, 1 connector
    expect(allOutput).toMatch(/0 tool\(s\) across 1 connector/);
  });

  it('shows CLI connector lines from cliConnectorLines()', async () => {
    const log = spyLog();
    vi.mocked(fetchConnectors).mockResolvedValue([]);
    vi.mocked(resolveCliConnectors).mockReturnValue([]);
    vi.mocked(isCliWildcard).mockReturnValue(false);
    vi.mocked(cliConnectorLines).mockReturnValue(['  gh ✓', '  jq ✓']);

    const code = await toolsCommand(undefined, false);

    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c) => c[0] as string).join('\n');
    expect(allOutput).toContain('gh ✓');
    expect(allOutput).toContain('jq ✓');
  });
});

// ============================================================================
// secretCommand
// ============================================================================

describe('secretCommand — set', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('stores a secret read from stdin and logs confirmation', async () => {
    const log = spyLog();
    vi.mocked(setSecret).mockImplementation(() => {});

    // Provide stdin content via mock of process.stdin async iteration
    const stdinMock = (async function* () {
      yield Buffer.from('my-secret-value');
    })();
    const origStdin = process.stdin;
    Object.defineProperty(process, 'stdin', {
      value: stdinMock,
      writable: true,
      configurable: true,
    });

    try {
      const code = await secretCommand(['set', 'sentry', 'SENTRY_AUTH_TOKEN'], false);
      expect(code).toBe(0);
      expect(vi.mocked(setSecret)).toHaveBeenCalledWith(
        'sentry',
        'SENTRY_AUTH_TOKEN',
        'my-secret-value',
      );
      expect(log.mock.calls[0]?.[0]).toContain('stored secret sentry/SENTRY_AUTH_TOKEN');
    } finally {
      Object.defineProperty(process, 'stdin', {
        value: origStdin,
        writable: true,
        configurable: true,
      });
    }
  });

  it('throws when connector is missing', async () => {
    await expect(secretCommand(['set'], false)).rejects.toThrow(/secret set requires/);
  });

  it('throws when field is missing', async () => {
    await expect(secretCommand(['set', 'github'], false)).rejects.toThrow(/secret set requires/);
  });

  it('throws when a 4th positional arg is provided (value in argv — security violation)', async () => {
    await expect(secretCommand(['set', 'sentry', 'TOKEN', 'leaked-value'], false)).rejects.toThrow(
      /does not accept the value as an argument/,
    );
  });

  it('throws when stdin is empty', async () => {
    // Empty stdin
    const stdinMock = (async function* () {
      yield Buffer.from('   '); // only whitespace → trimmed to ''
    })();
    const origStdin = process.stdin;
    Object.defineProperty(process, 'stdin', {
      value: stdinMock,
      writable: true,
      configurable: true,
    });

    try {
      await expect(secretCommand(['set', 'sentry', 'TOKEN'], false)).rejects.toThrow(
        /no secret value provided/,
      );
    } finally {
      Object.defineProperty(process, 'stdin', {
        value: origStdin,
        writable: true,
        configurable: true,
      });
    }
  });
});

describe('secretCommand — ls / list', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('prints a JSON array when --json and secrets exist', async () => {
    const log = spyLog();
    vi.mocked(listSecrets).mockReturnValue([
      { connector: 'sentry', field: 'SENTRY_AUTH_TOKEN' },
      { connector: 'github', field: 'GH_TOKEN' },
    ]);

    const code = await secretCommand(['ls'], true);

    expect(code).toBe(0);
    const raw = log.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw) as { secrets: { connector: string; field: string }[] };
    expect(parsed.secrets).toHaveLength(2);
    expect(parsed.secrets[0]?.connector).toBe('sentry');
  });

  it('prints text rows when not --json and secrets exist', async () => {
    const log = spyLog();
    vi.mocked(listSecrets).mockReturnValue([{ connector: 'sentry', field: 'SENTRY_AUTH_TOKEN' }]);

    const code = await secretCommand(['ls'], false);

    expect(code).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain('sentry/SENTRY_AUTH_TOKEN');
  });

  it('prints (no secrets stored) when list is empty and not --json', async () => {
    const log = spyLog();
    vi.mocked(listSecrets).mockReturnValue([]);

    const code = await secretCommand(['ls'], false);

    expect(code).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain('no secrets stored');
  });

  it('prints empty JSON array when list is empty and --json', async () => {
    const log = spyLog();
    vi.mocked(listSecrets).mockReturnValue([]);

    const code = await secretCommand(['ls'], true);

    expect(code).toBe(0);
    const raw = log.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw) as { secrets: unknown[] };
    expect(parsed.secrets).toHaveLength(0);
  });

  it('accepts "list" as well as "ls"', async () => {
    const log = spyLog();
    vi.mocked(listSecrets).mockReturnValue([{ connector: 'x', field: 'Y' }]);

    const code = await secretCommand(['list'], false);

    expect(code).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain('x/Y');
  });
});

describe('secretCommand — rm / remove', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('removes a secret and logs confirmation', async () => {
    const log = spyLog();
    vi.mocked(removeSecret).mockImplementation(() => {});

    const code = await secretCommand(['rm', 'sentry', 'SENTRY_AUTH_TOKEN'], false);

    expect(code).toBe(0);
    expect(vi.mocked(removeSecret)).toHaveBeenCalledWith('sentry', 'SENTRY_AUTH_TOKEN');
    expect(log.mock.calls[0]?.[0]).toContain('removed secret sentry/SENTRY_AUTH_TOKEN');
  });

  it('accepts "remove" as well as "rm"', async () => {
    spyLog();
    vi.mocked(removeSecret).mockImplementation(() => {});

    const code = await secretCommand(['remove', 'github', 'GH_TOKEN'], false);

    expect(code).toBe(0);
    expect(vi.mocked(removeSecret)).toHaveBeenCalledWith('github', 'GH_TOKEN');
  });

  it('throws when connector is missing', async () => {
    await expect(secretCommand(['rm'], false)).rejects.toThrow(/secret rm requires/);
  });

  it('throws when field is missing', async () => {
    await expect(secretCommand(['rm', 'sentry'], false)).rejects.toThrow(/secret rm requires/);
  });
});

describe('secretCommand — unknown verb', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('throws on an unknown verb', async () => {
    await expect(secretCommand(['bogus'], false)).rejects.toThrow(/unknown 'secret' verb 'bogus'/);
  });

  it('throws a friendly message when no verb is provided (empty args)', async () => {
    await expect(secretCommand([], false)).rejects.toThrow(/unknown 'secret' verb ''/);
  });
});

// ============================================================================
// loadAgentConfig
// ============================================================================

describe('loadAgentConfig', () => {
  // Save + restore process.env around each test
  let savedEnv: Record<string, string | undefined>;

  function setRequiredEnv() {
    process.env['SLACK_SIGNING_SECRET'] = 'sign-secret';
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-bot';
    process.env['SLACK_BOT_USER_ID'] = 'U0BOT';
    process.env['SLACK_TEAM_ID'] = 'T0TEAM';
    process.env['SYM_OWNER_SLACK_USER_ID'] = 'U0OWNER';
    process.env['FIREWORKS_API_KEY'] = 'fw-key';
    process.env['FIREWORKS_MODEL'] = 'accounts/fw/models/llama';
  }

  beforeEach(() => {
    savedEnv = { ...process.env } as Record<string, string | undefined>;
    vi.mocked(loadConnectorConfigs).mockReturnValue({
      mcpServers: [],
      source: 'none',
      path: '/fake/.sym/config.json',
    });
  });

  afterEach(() => {
    // Restore only the keys that were present; delete keys that weren't
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    vi.restoreAllMocks();
  });

  it('loads valid config from env', () => {
    setRequiredEnv();
    delete process.env['FIREWORKS_BASE_URL'];
    delete process.env['SLACK_OWNER_USER_TOKEN'];
    delete process.env['AGENT_PORT'];

    const cfg = loadAgentConfig();

    expect(cfg.slackSigningSecret).toBe('sign-secret');
    expect(cfg.slackBotToken).toBe('xoxb-bot');
    expect(cfg.slackBotUserId).toBe('U0BOT');
    expect(cfg.slackTeamId).toBe('T0TEAM');
    expect(cfg.ownerSlackUserId).toBe('U0OWNER');
    expect(cfg.fireworksApiKey).toBe('fw-key');
    expect(cfg.fireworksModel).toBe('accounts/fw/models/llama');
    expect(cfg.fireworksBaseUrl).toBe('https://api.fireworks.ai/inference/v1');
    expect(cfg.port).toBe(3001); // default
    expect(cfg.slackUserToken).toBeUndefined();
  });

  it('reads AGENT_PORT from env', () => {
    setRequiredEnv();
    process.env['AGENT_PORT'] = '4242';

    const cfg = loadAgentConfig();
    expect(cfg.port).toBe(4242);
  });

  it('reads FIREWORKS_BASE_URL from env when set', () => {
    setRequiredEnv();
    process.env['FIREWORKS_BASE_URL'] = 'https://custom.fireworks.ai/v1';

    const cfg = loadAgentConfig();
    expect(cfg.fireworksBaseUrl).toBe('https://custom.fireworks.ai/v1');
  });

  it('includes slackUserToken when SLACK_OWNER_USER_TOKEN is set', () => {
    setRequiredEnv();
    process.env['SLACK_OWNER_USER_TOKEN'] = 'xoxp-owner';

    const cfg = loadAgentConfig();
    expect(cfg.slackUserToken).toBe('xoxp-owner');
  });

  it('defaults the persona to sym when SYM_PERSONA is unset', () => {
    setRequiredEnv();
    delete process.env['SYM_PERSONA'];

    expect(loadAgentConfig().behavior.persona).toBe('sym');
  });

  it('reads SYM_PERSONA case-insensitively, trims it, and falls back to sym on unknown/empty', () => {
    setRequiredEnv();

    process.env['SYM_PERSONA'] = 'Concierge';
    expect(loadAgentConfig().behavior.persona).toBe('concierge');

    process.env['SYM_PERSONA'] = '  OPERATOR  ';
    expect(loadAgentConfig().behavior.persona).toBe('operator');

    process.env['SYM_PERSONA'] = 'wizard';
    expect(loadAgentConfig().behavior.persona).toBe('sym');

    process.env['SYM_PERSONA'] = '';
    expect(loadAgentConfig().behavior.persona).toBe('sym');
  });

  it('throws when SLACK_SIGNING_SECRET is missing', () => {
    setRequiredEnv();
    delete process.env['SLACK_SIGNING_SECRET'];

    expect(() => loadAgentConfig()).toThrow('SLACK_SIGNING_SECRET is required');
  });

  it('throws when SLACK_BOT_TOKEN is missing', () => {
    setRequiredEnv();
    delete process.env['SLACK_BOT_TOKEN'];

    expect(() => loadAgentConfig()).toThrow('SLACK_BOT_TOKEN is required');
  });

  it('throws when SLACK_BOT_USER_ID is missing', () => {
    setRequiredEnv();
    delete process.env['SLACK_BOT_USER_ID'];

    expect(() => loadAgentConfig()).toThrow('SLACK_BOT_USER_ID is required');
  });

  it('throws when SLACK_TEAM_ID is missing', () => {
    setRequiredEnv();
    delete process.env['SLACK_TEAM_ID'];

    expect(() => loadAgentConfig()).toThrow('SLACK_TEAM_ID is required');
  });

  it('throws when SYM_OWNER_SLACK_USER_ID is missing', () => {
    setRequiredEnv();
    delete process.env['SYM_OWNER_SLACK_USER_ID'];

    expect(() => loadAgentConfig()).toThrow('SYM_OWNER_SLACK_USER_ID is required');
  });

  it('throws when FIREWORKS_API_KEY is missing', () => {
    setRequiredEnv();
    delete process.env['FIREWORKS_API_KEY'];

    expect(() => loadAgentConfig()).toThrow('FIREWORKS_API_KEY is required');
  });

  it('throws when FIREWORKS_MODEL is missing', () => {
    setRequiredEnv();
    delete process.env['FIREWORKS_MODEL'];

    expect(() => loadAgentConfig()).toThrow('FIREWORKS_MODEL is required');
  });

  it('behavior defaults: taskCardThreshold=1, taskCardAfter=delete, ownerPostMarker=true', () => {
    setRequiredEnv();
    delete process.env['TASK_CARD_THRESHOLD'];
    delete process.env['TASK_CARD_AFTER'];
    delete process.env['OWNER_POST_MARKER'];
    delete process.env['SYM_CLI_CONFIRM'];
    delete process.env['SYM_TURN_DEADLINE_MS'];
    delete process.env['SYM_THREAD_HISTORY_LIMIT'];

    const cfg = loadAgentConfig();
    expect(cfg.behavior.taskCardThreshold).toBe(1);
    expect(cfg.behavior.taskCardAfter).toBe('delete');
    expect(cfg.behavior.ownerPostMarker).toBe(true);
    expect(cfg.behavior.cliConfirm).toBe(false);
    expect(cfg.behavior.turnDeadlineMs).toBe(1_800_000);
    expect(cfg.behavior.threadHistoryLimit).toBe(80);
  });

  it('TASK_CARD_THRESHOLD: numeric env value is parsed', () => {
    setRequiredEnv();
    process.env['TASK_CARD_THRESHOLD'] = '3';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.taskCardThreshold).toBe(3);
  });

  it('TASK_CARD_THRESHOLD: invalid string falls back to default 1', () => {
    setRequiredEnv();
    process.env['TASK_CARD_THRESHOLD'] = 'not-a-number';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.taskCardThreshold).toBe(1);
  });

  it('TASK_CARD_THRESHOLD: 0 is a valid value (disables task card)', () => {
    setRequiredEnv();
    process.env['TASK_CARD_THRESHOLD'] = '0';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.taskCardThreshold).toBe(0);
  });

  it('TASK_CARD_AFTER: collapse is accepted', () => {
    setRequiredEnv();
    process.env['TASK_CARD_AFTER'] = 'collapse';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.taskCardAfter).toBe('collapse');
  });

  it('TASK_CARD_AFTER: invalid value falls back to delete', () => {
    setRequiredEnv();
    process.env['TASK_CARD_AFTER'] = 'invalid';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.taskCardAfter).toBe('delete');
  });

  it('OWNER_POST_MARKER: "false" disables the marker', () => {
    setRequiredEnv();
    process.env['OWNER_POST_MARKER'] = 'false';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.ownerPostMarker).toBe(false);
  });

  it('OWNER_POST_MARKER: any value other than "false" enables the marker', () => {
    setRequiredEnv();
    process.env['OWNER_POST_MARKER'] = 'true';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.ownerPostMarker).toBe(true);
  });

  it('SYM_CLI_CONFIRM: "true" enables cliConfirm', () => {
    setRequiredEnv();
    process.env['SYM_CLI_CONFIRM'] = 'true';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.cliConfirm).toBe(true);
  });

  it('SYM_CLI_CONFIRM: "1" enables cliConfirm', () => {
    setRequiredEnv();
    process.env['SYM_CLI_CONFIRM'] = '1';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.cliConfirm).toBe(true);
  });

  it('SYM_CLI_CONFIRM: "yes" enables cliConfirm', () => {
    setRequiredEnv();
    process.env['SYM_CLI_CONFIRM'] = 'yes';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.cliConfirm).toBe(true);
  });

  it('SYM_CLI_CONFIRM: "on" enables cliConfirm', () => {
    setRequiredEnv();
    process.env['SYM_CLI_CONFIRM'] = 'on';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.cliConfirm).toBe(true);
  });

  it('SYM_CLI_CONFIRM: absent/falsy disables cliConfirm', () => {
    setRequiredEnv();
    delete process.env['SYM_CLI_CONFIRM'];

    const cfg = loadAgentConfig();
    expect(cfg.behavior.cliConfirm).toBe(false);
  });

  it('SYM_TURN_DEADLINE_MS: custom value is parsed', () => {
    setRequiredEnv();
    process.env['SYM_TURN_DEADLINE_MS'] = '30000';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.turnDeadlineMs).toBe(30_000);
  });

  it('SYM_TURN_DEADLINE_MS: 0 disables the deadline', () => {
    setRequiredEnv();
    process.env['SYM_TURN_DEADLINE_MS'] = '0';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.turnDeadlineMs).toBe(0);
  });

  it('SYM_TURN_DEADLINE_MS: invalid value falls back to 1800000', () => {
    setRequiredEnv();
    process.env['SYM_TURN_DEADLINE_MS'] = 'bad';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.turnDeadlineMs).toBe(1_800_000);
  });

  it('SYM_THREAD_HISTORY_LIMIT: custom value is parsed', () => {
    setRequiredEnv();
    process.env['SYM_THREAD_HISTORY_LIMIT'] = '50';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.threadHistoryLimit).toBe(50);
  });

  it('SYM_THREAD_HISTORY_LIMIT: 0 disables the cap', () => {
    setRequiredEnv();
    process.env['SYM_THREAD_HISTORY_LIMIT'] = '0';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.threadHistoryLimit).toBe(0);
  });

  it('SYM_THREAD_HISTORY_LIMIT: invalid value falls back to 80', () => {
    setRequiredEnv();
    process.env['SYM_THREAD_HISTORY_LIMIT'] = 'not-a-number';

    const cfg = loadAgentConfig();
    expect(cfg.behavior.threadHistoryLimit).toBe(80);
  });

  it('mcpServers and mcpConfigSource come from loadConnectorConfigs', () => {
    setRequiredEnv();
    vi.mocked(loadConnectorConfigs).mockReturnValue({
      mcpServers: [{ name: 'github', transport: { kind: 'stdio', command: 'node', args: [] } }],
      source: 'file',
      path: '/fake/.sym/config.json',
    });

    const cfg = loadAgentConfig();
    expect(cfg.mcpServers).toHaveLength(1);
    expect(cfg.mcpServers[0]?.name).toBe('github');
    expect(cfg.mcpConfigSource).toBe('file');
  });
});

// ============================================================================
// showCommand
// ============================================================================

describe('showCommand', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it('throws when name is undefined', async () => {
    await expect(showCommand(undefined, false)).rejects.toThrow(/show requires a connector name/);
  });

  it('throws when name is empty string', async () => {
    await expect(showCommand('', false)).rejects.toThrow(/show requires a connector name/);
  });

  it('prints JSON output with config+health+tools when agent is reachable', async () => {
    const log = spyLog();
    vi.mocked(loadConfigFile).mockReturnValue({
      version: 1,
      mcpServers: [{ name: 'github', transport: { kind: 'stdio', command: 'node', args: [] } }],
    });
    vi.mocked(fetchConnectors).mockResolvedValue([
      { name: 'github', ok: true, transport: 'stdio', auth: 'none', trust: false, tools: 2 },
    ]);
    vi.mocked(fetchConnectorTools).mockResolvedValue([
      { name: 'create_issue', description: 'Create an issue' },
      { name: 'list_prs', description: 'List pull requests' },
    ]);

    const code = await showCommand('github', true);

    expect(code).toBe(0);
    const raw = log.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw) as {
      name: string;
      config: { name: string } | null;
      health: { name: string; ok: boolean } | null;
      tools: { name: string }[];
    };
    expect(parsed.name).toBe('github');
    expect(parsed.config?.name).toBe('github');
    expect(parsed.health?.name).toBe('github');
    expect(parsed.health?.ok).toBe(true);
    expect(parsed.tools).toHaveLength(2);
  });

  it('prints text output with health + config + tools when agent is reachable', async () => {
    const log = spyLog();
    vi.mocked(loadConfigFile).mockReturnValue({
      version: 1,
      mcpServers: [{ name: 'github', transport: { kind: 'stdio', command: 'node', args: [] } }],
    });
    vi.mocked(fetchConnectors).mockResolvedValue([
      { name: 'github', ok: true, transport: 'stdio', auth: 'none', trust: false, tools: 2 },
    ]);
    vi.mocked(fetchConnectorTools).mockResolvedValue([
      { name: 'create_issue', description: 'Create an issue' },
    ]);
    vi.mocked(vi.mocked(vi.fn())); // no-op to satisfy the vi import
    // healthWord mock
    const { healthWord } = await import('../src/cli/commands/render.js');
    vi.mocked(healthWord).mockReturnValue('connected');

    const code = await showCommand('github', false);

    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c) => c[0] as string).join('\n');
    expect(allOutput).toContain('connector: github');
    expect(allOutput).toContain('health:');
    expect(allOutput).toContain('config:');
    expect(allOutput).toContain('tools (1):');
    expect(allOutput).toContain('create_issue');
  });

  it('prints "(agent not reachable)" when agent is offline', async () => {
    const log = spyLog();
    vi.mocked(loadConfigFile).mockReturnValue({
      version: 1,
      mcpServers: [{ name: 'github', transport: { kind: 'stdio', command: 'node', args: [] } }],
    });
    vi.mocked(fetchConnectors).mockRejectedValue(new Error('ECONNREFUSED'));

    const code = await showCommand('github', false);

    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c) => c[0] as string).join('\n');
    expect(allOutput).toContain('connector: github');
    expect(allOutput).toContain('agent not reachable');
  });

  it('returns 1 when neither config nor health is available for the connector', async () => {
    const log = spyLog();
    vi.mocked(loadConfigFile).mockReturnValue({
      version: 1,
      mcpServers: [], // no github in config
    });
    vi.mocked(fetchConnectors).mockRejectedValue(new Error('offline'));

    const code = await showCommand('github', false);

    expect(code).toBe(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/no connector named 'github'/);
  });

  it('shows config-only when connector is in config but not in live health', async () => {
    const log = spyLog();
    vi.mocked(loadConfigFile).mockReturnValue({
      version: 1,
      mcpServers: [{ name: 'github', transport: { kind: 'stdio', command: 'node', args: [] } }],
    });
    // fetchConnectors returns other connectors, but not github
    vi.mocked(fetchConnectors).mockResolvedValue([
      { name: 'linear', ok: true, transport: 'stdio', auth: 'none', trust: false, tools: 1 },
    ]);
    vi.mocked(fetchConnectorTools).mockResolvedValue([]);

    const code = await showCommand('github', false);

    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c) => c[0] as string).join('\n');
    expect(allOutput).toContain('connector: github');
    expect(allOutput).toContain('agent not reachable');
  });

  it('JSON output shows null config when connector not in config file', async () => {
    const log = spyLog();
    vi.mocked(loadConfigFile).mockReturnValue({
      version: 1,
      mcpServers: [], // not in config
    });
    vi.mocked(fetchConnectors).mockResolvedValue([
      { name: 'github', ok: true, transport: 'stdio', auth: 'none', trust: false, tools: 0 },
    ]);
    vi.mocked(fetchConnectorTools).mockResolvedValue([]);

    const code = await showCommand('github', true);

    expect(code).toBe(0);
    const raw = log.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw) as { config: null; health: { name: string } | null };
    expect(parsed.config).toBeNull();
    expect(parsed.health?.name).toBe('github');
  });

  it('shows connector error in health line when present', async () => {
    const log = spyLog();
    vi.mocked(loadConfigFile).mockReturnValue({
      version: 1,
      mcpServers: [{ name: 'sentry', transport: { kind: 'stdio', command: 'node', args: [] } }],
    });
    vi.mocked(fetchConnectors).mockResolvedValue([
      {
        name: 'sentry',
        ok: false,
        transport: 'stdio',
        auth: 'none',
        trust: false,
        tools: 0,
        error: 'spawn failed: not found',
      },
    ]);
    vi.mocked(fetchConnectorTools).mockResolvedValue([]);
    const { healthWord } = await import('../src/cli/commands/render.js');
    vi.mocked(healthWord).mockReturnValue('failed');

    const code = await showCommand('sentry', false);

    expect(code).toBe(0);
    const allOutput = log.mock.calls.map((c) => c[0] as string).join('\n');
    expect(allOutput).toContain('spawn failed: not found');
  });
});
