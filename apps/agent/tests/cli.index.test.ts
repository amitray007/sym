/**
 * `sym` CLI glue — unit coverage for the one piece of logic in the entrypoint:
 * turning `mcp add` flags (shorthand or --json) into a ConnectorConfig.
 *
 * The verb wiring itself is exercised live; the three backing modules
 * (config-store, admin-client, secrets) have their own real-wire suites.
 */

import { describe, expect, it } from 'vitest';

import { connectorFromAddFlags } from '../src/cli/index.js';

describe('connectorFromAddFlags', () => {
  it('builds a stdio connector from --name/--command/--arg', () => {
    const c = connectorFromAddFlags({
      name: 'echo',
      command: 'node',
      arg: ['server.mjs', '--flag'],
      trust: true,
    });
    expect(c).toEqual({
      name: 'echo',
      transport: { kind: 'stdio', command: 'node', args: ['server.mjs', '--flag'] },
      trust: true,
    });
  });

  it('omits args when none are given and omits trust when not set', () => {
    const c = connectorFromAddFlags({ name: 'bare', command: 'foo-mcp' });
    expect(c).toEqual({ name: 'bare', transport: { kind: 'stdio', command: 'foo-mcp' } });
  });

  it('builds an http connector from --name/--url', () => {
    const c = connectorFromAddFlags({ name: 'remote', url: 'https://example.com/mcp' });
    expect(c.transport).toEqual({ kind: 'http', url: 'https://example.com/mcp' });
  });

  it('passes a full --json connector through (with auth/injection)', () => {
    const json = JSON.stringify({
      name: 'sentry',
      transport: { kind: 'stdio', command: 'sentry-mcp' },
      auth: { kind: 'static', secret: 'x', inject: { at: 'env', name: 'SENTRY_AUTH_TOKEN' } },
    });
    const c = connectorFromAddFlags({ json });
    expect(c.name).toBe('sentry');
    expect(c.auth).toEqual({
      kind: 'static',
      secret: 'x',
      inject: { at: 'env', name: 'SENTRY_AUTH_TOKEN' },
    });
  });

  it('throws when neither --command nor --url is given', () => {
    expect(() => connectorFromAddFlags({ name: 'x' })).toThrow(/--command.*--url|--json/);
  });

  it('throws when --json has no name', () => {
    expect(() =>
      connectorFromAddFlags({ json: '{"transport":{"kind":"http","url":"u"}}' }),
    ).toThrow(/name/);
  });

  it('throws when neither --name nor --json is given', () => {
    expect(() => connectorFromAddFlags({ command: 'foo' })).toThrow(/--name/);
  });
});
