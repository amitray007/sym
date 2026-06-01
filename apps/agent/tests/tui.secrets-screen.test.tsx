/**
 * Tests for SecretsScreen — list, add, delete, back, and missing-key handling.
 *
 * Timing notes:
 *   ink-testing-library's stdin is synchronous but React effects (useInput handler
 *   registration) are async.  Pattern used throughout:
 *     1. await new Promise(r => setTimeout(r, 50))  ← let effects register
 *     2. stdin.write(text)                           ← write text as one chunk
 *     3. await vi.waitFor(() => expect(lastFrame()).toContain(text))  ← wait for re-render
 *     4. await new Promise(r => setTimeout(r, 50))  ← let effects re-register with new value
 *     5. stdin.write('\r')                           ← submit; onSubmit now sees the right value
 */

import { render } from 'ink-testing-library';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listSecrets, setSecret, removeSecret } from '../src/cli/secrets.js';
import { SecretsScreen } from '../src/tui/screens/SecretsScreen.js';

vi.mock('../src/cli/secrets.js', () => ({
  listSecrets: vi.fn(() => [{ connector: 'sentry', field: 'SENTRY_AUTH_TOKEN' }]),
  setSecret: vi.fn(),
  removeSecret: vi.fn(),
}));

const mockedListSecrets = vi.mocked(listSecrets);
const mockedSetSecret = vi.mocked(setSecret);
const mockedRemoveSecret = vi.mocked(removeSecret);

/** Convenience: wait for effects to register / re-register. */
const tick = () => new Promise<void>((r) => setTimeout(r, 50));

beforeEach(() => {
  vi.clearAllMocks();
  mockedListSecrets.mockReturnValue([{ connector: 'sentry', field: 'SENTRY_AUTH_TOKEN' }]);
});

describe('SecretsScreen', () => {
  it('Test 1: list mode shows sentry/SENTRY_AUTH_TOKEN', async () => {
    const { lastFrame } = render(<SecretsScreen onBack={vi.fn()} />);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('sentry/SENTRY_AUTH_TOKEN');
    });
  });

  it('Test 2: pressing a then entering connector/field/value calls setSecret', async () => {
    const { lastFrame, stdin } = render(<SecretsScreen onBack={vi.fn()} />);

    // Wait for list mode to render + effects to register
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('sentry/SENTRY_AUTH_TOKEN');
    });
    await tick();

    // Enter add mode
    stdin.write('a');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Connector name');
    });
    await tick();

    // --- connector step ---
    stdin.write('github');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('github');
    });
    await tick();
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Field name');
    });
    await tick();

    // --- field step ---
    stdin.write('GITHUB_TOKEN');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('GITHUB_TOKEN');
    });
    await tick();
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('Secret value');
    });
    await tick();

    // --- value step ---
    stdin.write('ghp_secret123');
    // value is masked with '*' — wait for mask chars to appear
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('*');
    });
    await tick();
    stdin.write('\r');

    await vi.waitFor(() => {
      expect(mockedSetSecret).toHaveBeenCalledWith('github', 'GITHUB_TOKEN', 'ghp_secret123');
    });
  });

  it('Test 3: pressing d calls removeSecret with the last secret', async () => {
    const { lastFrame, stdin } = render(<SecretsScreen onBack={vi.fn()} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('sentry/SENTRY_AUTH_TOKEN');
    });
    await tick();

    stdin.write('d');

    await vi.waitFor(() => {
      expect(mockedRemoveSecret).toHaveBeenCalledWith('sentry', 'SENTRY_AUTH_TOKEN');
    });
  });

  it('Test 4: pressing b calls onBack', async () => {
    const onBack = vi.fn();
    const { lastFrame, stdin } = render(<SecretsScreen onBack={onBack} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('sentry/SENTRY_AUTH_TOKEN');
    });
    await tick();

    stdin.write('b');

    await vi.waitFor(() => {
      expect(onBack).toHaveBeenCalled();
    });
  });

  it('Test 5: when listSecrets throws, shows friendly SYM_ENCRYPTION_KEY hint', async () => {
    mockedListSecrets.mockImplementation(() => {
      throw new Error('no key');
    });

    const { lastFrame } = render(<SecretsScreen onBack={vi.fn()} />);

    await vi.waitFor(() => {
      expect(lastFrame()).toContain('SYM_ENCRYPTION_KEY');
    });
  });
});
