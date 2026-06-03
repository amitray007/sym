/**
 * SecretsManager — list/add/delete/error paths. secrets + config-store + source
 * are mocked; the render path is real (ink-testing-library).
 */

import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as McpRuntime from '@sym/mcp-runtime';

vi.mock('../src/cli/secrets.js', () => ({
  listSecrets: vi.fn(() => [{ connector: 'sentry', field: 'SENTRY_AUTH_TOKEN' }]),
  setSecret: vi.fn(),
  removeSecret: vi.fn(),
}));
vi.mock('../src/cli/config-store.js', () => ({
  loadConfigFile: vi.fn(() => ({
    version: 1,
    mcpServers: [{ name: 'sentry', transport: { kind: 'stdio', command: 'x' } }],
  })),
}));
vi.mock('@sym/mcp-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof McpRuntime>()),
  configPath: () => '/tmp/x.json',
}));

import { listSecrets, removeSecret, setSecret } from '../src/cli/secrets.js';
import { SecretsManager } from '../src/tui/screens/SecretsManager.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 50));
const noop = (): void => undefined;

afterEach(() => vi.clearAllMocks());

describe('SecretsManager', () => {
  it('renders the secret table with connector, field and "referenced" ref', async () => {
    const { lastFrame } = render(<SecretsManager onBack={noop} />);
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('sentry'));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('SENTRY_AUTH_TOKEN');
    expect(frame).toContain('referenced');
  });

  it('enters add mode on "a", types connector/field/value, calls setSecret', async () => {
    const { stdin, lastFrame } = render(<SecretsManager onBack={noop} />);
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('sentry'));
    await tick();

    // enter add mode
    stdin.write('a');
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('connector name'));
    await tick(); // let useInput effects register

    // type connector + submit
    stdin.write('github');
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('field name'));
    await tick(); // let useInput effects register

    // type field + submit
    stdin.write('GITHUB_TOKEN');
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('secret value'));
    await tick(); // let useInput effects register

    // type value + submit
    stdin.write('ghp_secret123');
    stdin.write('\r');
    await vi.waitFor(() =>
      expect(setSecret).toHaveBeenCalledWith('github', 'GITHUB_TOKEN', 'ghp_secret123'),
    );
  });

  it('calls removeSecret on "d" for the selected row', async () => {
    const { stdin, lastFrame } = render(<SecretsManager onBack={noop} />);
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('sentry'));
    await tick();

    stdin.write('d');
    await vi.waitFor(() =>
      expect(removeSecret).toHaveBeenCalledWith('sentry', 'SENTRY_AUTH_TOKEN'),
    );
  });

  it('calls onBack when "b" is pressed', async () => {
    const onBack = vi.fn();
    const { stdin, lastFrame } = render(<SecretsManager onBack={onBack} />);
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('sentry'));
    await tick();

    stdin.write('b');
    await vi.waitFor(() => expect(onBack).toHaveBeenCalled());
  });

  it('shows the SYM_ENCRYPTION_KEY hint when listSecrets throws (no crash)', async () => {
    vi.mocked(listSecrets).mockImplementationOnce(() => {
      throw new Error('SYM_ENCRYPTION_KEY not set');
    });
    const { lastFrame } = render(<SecretsManager onBack={noop} />);
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('SYM_ENCRYPTION_KEY'));
    // must not be an error boundary / crash message
    expect(lastFrame() ?? '').not.toContain('Uncaught');
  });
});
