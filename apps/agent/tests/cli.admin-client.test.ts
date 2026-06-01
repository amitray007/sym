/**
 * admin-client integration tests — real node:http server, no mocks.
 *
 * Starts a minimal HTTP server on 127.0.0.1 port 0 and routes by method+URL
 * to mirror the agent's /admin/reload and /admin/status handlers. Each test
 * exercises applyReload / fetchStatus against the live server.
 */

import * as http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { applyReload, fetchStatus } from '../src/cli/admin-client.js';

import type { ReloadResponse, StatusResponse } from '../src/cli/admin-client.js';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Canned fixture responses
// ---------------------------------------------------------------------------

const CANNED_RELOAD: ReloadResponse = {
  source: 'file',
  path: '/data/sym/connectors.json',
  totalTools: 5,
  connectors: [
    { name: 'github', status: 'connected', tools: 3 },
    { name: 'linear', status: 'unchanged', tools: 2 },
  ],
};

const CANNED_STATUS: StatusResponse = {
  connectors: ['github', 'linear'],
  totalTools: 5,
};

// ---------------------------------------------------------------------------
// Minimal admin HTTP server
// ---------------------------------------------------------------------------

/** Start a real HTTP server on 127.0.0.1:0 that mirrors the agent's admin routes. */
async function startAdminFixture(): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (method === 'POST' && url === '/admin/reload') {
      const body = JSON.stringify(CANNED_RELOAD);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString(),
      });
      res.end(body);
      return;
    }

    if (method === 'GET' && url === '/admin/status') {
      const body = JSON.stringify(CANNED_STATUS);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString(),
      });
      res.end(body);
      return;
    }

    res.writeHead(404).end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port.toString()}`;

  return {
    baseUrl,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err !== undefined ? reject(err) : resolve()));
      }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('admin-client', () => {
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (stop !== undefined) {
      await stop();
      stop = undefined;
    }
  });

  it('applyReload — parses ReloadResponse correctly', async () => {
    const fixture = await startAdminFixture();
    stop = fixture.stop;

    const result = await applyReload(fixture.baseUrl);

    expect(result.source).toBe('file');
    expect(result.path).toBe('/data/sym/connectors.json');
    expect(result.totalTools).toBe(5);
    expect(result.connectors).toHaveLength(2);
    expect(result.connectors[0]).toMatchObject({ name: 'github', status: 'connected', tools: 3 });
    expect(result.connectors[1]).toMatchObject({ name: 'linear', status: 'unchanged', tools: 2 });
  });

  it('fetchStatus — parses StatusResponse correctly', async () => {
    const fixture = await startAdminFixture();
    stop = fixture.stop;

    const result = await fetchStatus(fixture.baseUrl);

    expect(result.totalTools).toBe(5);
    expect(result.connectors).toEqual(['github', 'linear']);
  });

  it('fetchStatus — rejects with friendly message when agent is not running', async () => {
    // Port 1 is reserved and will refuse connections on most systems.
    await expect(fetchStatus('http://127.0.0.1:1')).rejects.toThrow(
      'could not reach the Sym admin endpoint at http://127.0.0.1:1/admin/status — is the agent running?',
    );
  });

  it('applyReload — throws with status code on non-OK response', async () => {
    // Serve a 500 for all requests.
    const errorServer = http.createServer((_req, res) => {
      res.writeHead(500).end('internal error');
    });
    await new Promise<void>((resolve, reject) => {
      errorServer.once('error', reject);
      errorServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = errorServer.address() as AddressInfo;
    const errorBase = `http://127.0.0.1:${port.toString()}`;

    try {
      await expect(applyReload(errorBase)).rejects.toThrow('HTTP 500');
    } finally {
      await new Promise<void>((resolve, reject) => {
        errorServer.close((err) => (err !== undefined ? reject(err) : resolve()));
      });
    }
  });

  it('fetchStatus — throws with status code on non-OK response', async () => {
    const errorServer = http.createServer((_req, res) => {
      res.writeHead(403).end('forbidden');
    });
    await new Promise<void>((resolve, reject) => {
      errorServer.once('error', reject);
      errorServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = errorServer.address() as AddressInfo;
    const errorBase = `http://127.0.0.1:${port.toString()}`;

    try {
      await expect(fetchStatus(errorBase)).rejects.toThrow('HTTP 403');
    } finally {
      await new Promise<void>((resolve, reject) => {
        errorServer.close((err) => (err !== undefined ? reject(err) : resolve()));
      });
    }
  });
});
