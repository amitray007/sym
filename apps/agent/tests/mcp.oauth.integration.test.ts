/**
 * MCP OAuth integration tests (C3a) — NO SDK mocks.
 *
 * These tests stand up real in-process servers and use real stores to validate
 * the full OAuth machinery:
 *
 * (C1) Store round-trip: SqliteCredentialStore(':memory:') with a real AES-256-GCM
 *      key. Assert values come back equal, raw column is NOT plaintext (encrypted),
 *      and constructing the store WITHOUT a key throws (fail-closed).
 *
 * (C2) OAuthProvider + native arm wiring: stand up a minimal mock MCP server that
 *      returns 401 on first connect (triggering UnauthorizedError + registry capture),
 *      then drive completeOAuth → finishAuth → tokens stored → reconnect succeeds.
 *      This test stands up:
 *        - A mock MCP HTTP server (protected by Bearer token)
 *        - A mock OAuth Authorization Server implementing the minimum endpoints the
 *          SDK calls: /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server,
 *          /register (DCR), /authorize (issues a code via redirect), /token (PKCE exchange)
 *      Then drives the REAL McpDispatcher / OAuthProvider / StreamableHTTPClientTransport.
 *
 * (C3) CSRF rejection: completeOAuth with wrong state is rejected.
 */

import * as nodeCrypto from 'node:crypto';
import * as http from 'node:http';

import { Server as McpLowLevelServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { McpDispatcher, _resetPoolForTesting } from '../src/mcp/dispatcher.js';
import {
  completeOAuth,
  getPendingAuth,
  _resetRegistryForTesting,
} from '../src/mcp/oauth-registry.js';
import { makeOAuthProvider } from '../src/mcp/providers/oauth.js';
import {
  SqliteCredentialStore,
  parseEncryptionKey,
  _resetStoreForTesting,
} from '../src/mcp/store.js';

import type { ConnectorConfig } from '../src/mcp/config.js';
import type { StreamableHTTPServerTransportOptions } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Socket } from 'node:net';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a valid 32-byte base64 encryption key for tests. */
function makeTestKey(): string {
  return nodeCrypto.randomBytes(32).toString('base64');
}

/** Track and forcibly destroy open sockets on server shutdown. */
function trackSockets(server: http.Server): { destroy: () => void } {
  const sockets = new Set<Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return {
    destroy() {
      for (const s of sockets) s.destroy();
    },
  };
}

/** Start an HTTP server on a random port. Returns port + stop. */
async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ port: number; stop: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = http.createServer(handler);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('Unexpected address type');
  const port = addr.port;
  return {
    port,
    stop() {
      for (const s of sockets) s.destroy();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/**
 * Create a minimal stateless MCP HTTP server handler that:
 *   - Returns 401 + WWW-Authenticate when no valid Bearer token is present.
 *   - Handles MCP requests normally when the Bearer token == expectedToken.
 */
async function createProtectedMcpHandler(
  expectedToken: string,
  resourceMetadataUrl: string,
): Promise<(req: http.IncomingMessage, res: http.ServerResponse) => void> {
  return (req, res) => {
    // Check Authorization header
    const auth = req.headers['authorization'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;

    if (!token || token !== expectedToken) {
      // Return 401 with resource metadata URL in WWW-Authenticate
      res.writeHead(401, {
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"`,
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // Valid token — serve as stateless MCP
    const mcpServer = new McpLowLevelServer(
      { name: 'protected-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'secret_tool',
          description: 'A tool only available after OAuth',
          inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
        },
      ],
    }));

    mcpServer.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: 'text', text: 'authorized_response' }],
    }));

    const transportOpts = {
      sessionIdGenerator: undefined,
    } as unknown as StreamableHTTPServerTransportOptions;
    const transport = new StreamableHTTPServerTransport(transportOpts);

    (mcpServer.connect as (t: unknown) => Promise<void>)(transport)
      .then(() => transport.handleRequest(req, res))
      .then(() => {
        res.on('close', () => {
          void transport.close();
          void mcpServer.close();
        });
      })
      .catch((err: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500).end(JSON.stringify({ error: String(err) }));
        }
      });
  };
}

// ---------------------------------------------------------------------------
// (C1) SqliteCredentialStore — encrypted store round-trip
// ---------------------------------------------------------------------------

describe('C1: SqliteCredentialStore — encrypted round-trip', () => {
  it('round-trips client information through :memory: store (encrypted)', () => {
    const key = makeTestKey();
    const store = new SqliteCredentialStore(':memory:', key);

    const info: OAuthClientInformationFull = {
      client_id: 'test-client-123',
      client_secret: 'super-secret-456',
      redirect_uris: ['https://example.com/callback'],
    };

    store.saveClientInformation('my-connector', info);
    const retrieved = store.getClientInformation('my-connector');

    expect(retrieved).toEqual(info);
  });

  it('round-trips tokens through :memory: store', () => {
    const key = makeTestKey();
    const store = new SqliteCredentialStore(':memory:', key);

    const tokens: OAuthTokens = {
      access_token: 'access-abc',
      token_type: 'Bearer',
      refresh_token: 'refresh-xyz',
      expires_in: 3600,
      scope: 'read write',
    };

    store.saveTokens('my-connector', tokens);
    const retrieved = store.getTokens('my-connector');

    expect(retrieved).toEqual(tokens);
  });

  it('round-trips code verifier through :memory: store', () => {
    const key = makeTestKey();
    const store = new SqliteCredentialStore(':memory:', key);

    store.saveCodeVerifier('my-connector', 'pkce-verifier-abc123');
    expect(store.getCodeVerifier('my-connector')).toBe('pkce-verifier-abc123');

    store.clearCodeVerifier('my-connector');
    expect(store.getCodeVerifier('my-connector')).toBeUndefined();
  });

  it('raw DB column is NOT plaintext (values are encrypted)', () => {
    const key = makeTestKey();
    const store = new SqliteCredentialStore(':memory:', key);

    const secret = 'my-secret-access-token';
    const tokens: OAuthTokens = { access_token: secret, token_type: 'Bearer' };

    store.saveTokens('my-connector', tokens);

    // Read the raw encrypted blob directly
    const rawBlob = store._getRawEncryptedForTesting('my-connector', 'tokens');
    expect(rawBlob).toBeDefined();

    // The raw blob must NOT contain the plaintext secret
    expect(rawBlob).not.toContain(secret);
    // It should look like our iv:tag:ct format (three hex segments separated by colons)
    expect(rawBlob).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  });

  it('returns undefined for missing keys', () => {
    const key = makeTestKey();
    const store = new SqliteCredentialStore(':memory:', key);

    expect(store.getTokens('nonexistent')).toBeUndefined();
    expect(store.getClientInformation('nonexistent')).toBeUndefined();
    expect(store.getCodeVerifier('nonexistent')).toBeUndefined();
  });

  it('fail-closed: constructing store WITHOUT SYM_ENCRYPTION_KEY throws', () => {
    const origKey = process.env['SYM_ENCRYPTION_KEY'];
    delete process.env['SYM_ENCRYPTION_KEY'];

    try {
      expect(() => new SqliteCredentialStore(':memory:')).toThrow(/SYM_ENCRYPTION_KEY/);
    } finally {
      if (origKey !== undefined) {
        process.env['SYM_ENCRYPTION_KEY'] = origKey;
      }
    }
  });

  it('fail-closed: constructing store with wrong-length key throws', () => {
    expect(() => new SqliteCredentialStore(':memory:', 'tooshort')).toThrow(/32 bytes/);
  });

  it('accepts 32-byte key as hex (64 hex chars)', () => {
    const hexKey = nodeCrypto.randomBytes(32).toString('hex');
    const store = new SqliteCredentialStore(':memory:', hexKey);
    const tokens: OAuthTokens = { access_token: 'tok', token_type: 'Bearer' };
    store.saveTokens('c', tokens);
    expect(store.getTokens('c')).toEqual(tokens);
  });

  it('parseEncryptionKey throws on empty string', () => {
    expect(() => parseEncryptionKey('')).toThrow(/required/i);
    expect(() => parseEncryptionKey(undefined)).toThrow(/required/i);
  });
});

// ---------------------------------------------------------------------------
// (C2) Full mock-AS handshake test
// ---------------------------------------------------------------------------

describe('C2: Full OAuth handshake with mock MCP server + mock AS', () => {
  const ACCESS_TOKEN = 'mock-access-token-xyz';
  const CONNECTOR_NAME = 'mock-oauth-srv';
  let stopServers: (() => Promise<void>)[] = [];

  beforeEach(() => {
    _resetPoolForTesting();
    _resetRegistryForTesting();
    _resetStoreForTesting();
    stopServers = [];
    // Use a temporary in-memory DB path for tests via SYM_DB_PATH
    process.env['SYM_DB_PATH'] = ':memory:';
  });

  afterEach(async () => {
    _resetPoolForTesting();
    _resetRegistryForTesting();
    _resetStoreForTesting();
    delete process.env['SYM_PUBLIC_URL'];
    delete process.env['SYM_ENCRYPTION_KEY'];
    delete process.env['SYM_DB_PATH'];
    await Promise.all(stopServers.map((s) => s()));
  });

  /**
   * Stand up the mock Authorization Server.
   * The AS base URL is computed after the server starts (dynamic port),
   * so we pass a `getAsBase` factory to let the server compute URLs lazily.
   */
  async function startMockAS(
    getAsBase: () => string,
  ): Promise<{ port: number; stop: () => Promise<void>; issuedCodes: string[] }> {
    const issuedCodes: string[] = [];

    const srv = await startServer((req, res) => {
      const asBase = getAsBase();
      const url = new URL(req.url ?? '/', asBase);
      const path = url.pathname;

      // AS metadata
      if (path === '/.well-known/oauth-authorization-server') {
        const meta = {
          issuer: asBase,
          authorization_endpoint: `${asBase}/authorize`,
          token_endpoint: `${asBase}/token`,
          registration_endpoint: `${asBase}/register`,
          code_challenge_methods_supported: ['S256'],
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          token_endpoint_auth_methods_supported: ['none'],
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(meta));
        return;
      }

      // DCR — Dynamic Client Registration
      if (path === '/register' && req.method === 'POST') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          let redirectUris = ['https://example.com/callback'];
          try {
            const parsed = JSON.parse(body) as { redirect_uris?: string[] };
            if (parsed.redirect_uris?.length) redirectUris = parsed.redirect_uris;
          } catch {
            /* use defaults */
          }
          const clientInfo: OAuthClientInformationFull = {
            client_id: `mock-client-${Date.now()}`,
            redirect_uris: redirectUris,
            token_endpoint_auth_method: 'none',
          };
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(clientInfo));
        });
        return;
      }

      // /authorize — simulate user consent, redirect with code
      if (path === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        const state = url.searchParams.get('state') ?? '';
        const code = `auth-code-${Date.now()}-${Math.random()}`;
        issuedCodes.push(code);

        const callbackUrl = new URL(redirectUri || `${asBase}/callback`);
        callbackUrl.searchParams.set('code', code);
        if (state) callbackUrl.searchParams.set('state', state);

        res.writeHead(302, { Location: callbackUrl.toString() });
        res.end();
        return;
      }

      // /token — PKCE code exchange
      if (path === '/token' && req.method === 'POST') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          const params = new URLSearchParams(body);
          const grantType = params.get('grant_type');
          const code = params.get('code') ?? '';

          if (grantType !== 'authorization_code' || !issuedCodes.includes(code)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_grant' }));
            return;
          }

          const tokenResponse: OAuthTokens = {
            access_token: ACCESS_TOKEN,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'refresh-token-abc',
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(tokenResponse));
        });
        return;
      }

      res.writeHead(404).end(JSON.stringify({ error: 'not_found' }));
    });

    return { port: srv.port, stop: srv.stop, issuedCodes };
  }

  /**
   * Stand up the mock protected MCP server.
   * - Serves /.well-known/oauth-protected-resource
   * - Returns 401 without a valid Bearer token
   * - Serves MCP tools with a valid Bearer token
   */
  async function startMockMcpServer(
    getAsBase: () => string,
    getMcpBase: () => string,
  ): Promise<{ port: number; stop: () => Promise<void> }> {
    const resourceMetaPath = '/.well-known/oauth-protected-resource';

    const srv = await startServer((req, res) => {
      const mcpBase = getMcpBase();
      const asBase = getAsBase();
      const url = new URL(req.url ?? '/', mcpBase);
      const path = url.pathname;

      // Protected resource metadata (RFC 9728)
      if (path === resourceMetaPath) {
        const meta = {
          resource: mcpBase,
          authorization_servers: [asBase],
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(meta));
        return;
      }

      // Check auth on all other paths
      const auth = req.headers['authorization'];
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;

      if (!token || token !== ACCESS_TOKEN) {
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${mcpBase}${resourceMetaPath}"`,
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      // Valid token — serve MCP
      const mcpServer = new McpLowLevelServer(
        { name: 'protected-mcp', version: '1.0.0' },
        { capabilities: { tools: {} } },
      );
      mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'secret_tool',
            description: 'Tool only after OAuth',
            inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
          },
        ],
      }));
      mcpServer.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{ type: 'text', text: 'authorized_response' }],
      }));

      const transportOpts = {
        sessionIdGenerator: undefined,
      } as unknown as StreamableHTTPServerTransportOptions;
      const transport = new StreamableHTTPServerTransport(transportOpts);
      (mcpServer.connect as (t: unknown) => Promise<void>)(transport)
        .then(() => transport.handleRequest(req, res))
        .then(() => {
          res.on('close', () => {
            void transport.close();
            void mcpServer.close();
          });
        })
        .catch((err: unknown) => {
          if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ error: String(err) }));
        });
    });

    return { port: srv.port, stop: srv.stop };
  }

  it(
    'C2a: connect → UnauthorizedError captured → completeOAuth → finishAuth → tokens stored → reconnect returns tools',
    async () => {
      // Reserve ports by starting placeholder servers, then replace with real ones.
      // Use lazy getters so the servers can reference each other.
      let asPort = 0;
      let mcpPort = 0;
      const getAsBase = () => `http://127.0.0.1:${asPort}`;
      const getMcpBase = () => `http://127.0.0.1:${mcpPort}`;

      const asSrv = await startMockAS(getAsBase);
      asPort = asSrv.port;
      stopServers.push(asSrv.stop);

      const mcpSrv = await startMockMcpServer(getAsBase, getMcpBase);
      mcpPort = mcpSrv.port;
      stopServers.push(mcpSrv.stop);

      const asBase = getAsBase();
      const mcpBase = getMcpBase();

      // --- Set up encryption ---
      const key = makeTestKey();
      process.env['SYM_ENCRYPTION_KEY'] = key;
      process.env['SYM_PUBLIC_URL'] = mcpBase;

      const store = new SqliteCredentialStore(':memory:', key);

      const config: ConnectorConfig = {
        name: CONNECTOR_NAME,
        transport: { kind: 'http', url: mcpBase },
        auth: { kind: 'oauth' },
        trust: true,
      };

      // --- First connect: should fail open with 0 tools (UnauthorizedError path) ---
      const dispatcher = new McpDispatcher([config]);
      const toolsBefore = await dispatcher.listAsync();

      expect(toolsBefore).toHaveLength(0);

      // Registry must have captured the pending auth
      const pending = getPendingAuth(CONNECTOR_NAME);
      expect(pending).toBeDefined();
      expect(pending?.authorizeUrl).toBeDefined();
      expect(pending?.state).toBeDefined();

      // --- Simulate user visiting the authorize URL ---
      // The AS /authorize endpoint redirects to our callback with code+state.
      // We follow the redirect manually to extract code+state.
      const authorizeUrl = pending!.authorizeUrl;
      const authState = pending!.state;

      const asResponse = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
      expect(asResponse.status).toBe(302);
      const location = asResponse.headers.get('location') ?? '';
      const callbackUrl = new URL(location);
      const code = callbackUrl.searchParams.get('code') ?? '';
      const returnedState = callbackUrl.searchParams.get('state') ?? '';

      expect(code).toBeTruthy();
      expect(returnedState).toBe(authState);

      // --- Complete the OAuth flow (this calls transport.finishAuth) ---
      // Note: completeOAuth uses the transport from the registry,
      // which has the OAuthProvider backed by the module-level getStore().
      // Our test store is a separate instance, so we verify via the module store.
      await completeOAuth(CONNECTOR_NAME, code, returnedState);

      // --- Second connect: tokens available → should succeed ---
      // No manual pool reset: ensureEntry() retries failed OAuth connectors, so
      // the next listAsync reconnects with the now-stored tokens and comes online.
      // The dispatcher uses the module-level store (getStore()) which was
      // initialized with SYM_ENCRYPTION_KEY. The tokens are stored there.
      const dispatcher2 = new McpDispatcher([config]);
      const toolsAfter = await dispatcher2.listAsync();

      // Should now have the tool (OAuth tokens persisted → Bearer sent → 200)
      expect(toolsAfter.some((t) => t.name === `${CONNECTOR_NAME}__secret_tool`)).toBe(true);
    },
    { timeout: 30_000 },
  );

  it(
    'C2b: completeOAuth with wrong state is REJECTED (CSRF protection)',
    async () => {
      let asPort = 0;
      let mcpPort = 0;
      const getAsBase = () => `http://127.0.0.1:${asPort}`;
      const getMcpBase = () => `http://127.0.0.1:${mcpPort}`;

      const asSrv = await startMockAS(getAsBase);
      asPort = asSrv.port;
      stopServers.push(asSrv.stop);

      const mcpSrv = await startMockMcpServer(getAsBase, getMcpBase);
      mcpPort = mcpSrv.port;
      stopServers.push(mcpSrv.stop);

      const key = makeTestKey();
      process.env['SYM_ENCRYPTION_KEY'] = key;
      process.env['SYM_PUBLIC_URL'] = getMcpBase();

      const config: ConnectorConfig = {
        name: CONNECTOR_NAME,
        transport: { kind: 'http', url: getMcpBase() },
        auth: { kind: 'oauth' },
        trust: true,
      };

      const dispatcher = new McpDispatcher([config]);
      await dispatcher.listAsync(); // triggers UnauthorizedError → registry

      const pending = getPendingAuth(CONNECTOR_NAME);
      expect(pending).toBeDefined();

      // Try completeOAuth with WRONG state — must be rejected
      await expect(completeOAuth(CONNECTOR_NAME, 'some-code', 'WRONG-STATE-CSRF')).rejects.toThrow(
        /state mismatch|CSRF/i,
      );
    },
    { timeout: 15_000 },
  );
});

// ---------------------------------------------------------------------------
// (C3) Additional OAuthProvider unit tests
// ---------------------------------------------------------------------------

describe('C3: OAuthProvider — SdkOAuthAdapter and makeOAuthProvider', () => {
  beforeEach(() => {
    _resetRegistryForTesting();
  });

  afterEach(() => {
    _resetRegistryForTesting();
  });

  it('OAuthProvider.resolve() returns { apply: native, oauth: SdkOAuthAdapter }', async () => {
    const key = makeTestKey();
    const store = new SqliteCredentialStore(':memory:', key);
    const provider = makeOAuthProvider('test-connector', store, 'https://example.com');

    const resolved = await provider.resolve();
    expect(resolved.apply).toBe('native');
    expect(typeof (resolved as { apply: 'native'; oauth: unknown }).oauth).toBe('object');
  });

  it('SdkOAuthAdapter.state() returns the CSRF state string', async () => {
    const key = makeTestKey();
    const store = new SqliteCredentialStore(':memory:', key);
    const provider = makeOAuthProvider('test-connector', store, 'https://example.com');

    const resolved = await provider.resolve();
    const adapter = (resolved as { apply: 'native'; oauth: { state: () => string } }).oauth;
    const state = adapter.state();
    expect(typeof state).toBe('string');
    expect(state.length).toBeGreaterThan(16);
  });

  it('store persists tokens across multiple reads', () => {
    const key = makeTestKey();
    const store = new SqliteCredentialStore(':memory:', key);

    const tokens: OAuthTokens = { access_token: 'tok1', token_type: 'Bearer' };
    store.saveTokens('c1', tokens);

    // Second write overwrites
    const tokens2: OAuthTokens = { access_token: 'tok2', token_type: 'Bearer' };
    store.saveTokens('c1', tokens2);

    expect(store.getTokens('c1')).toEqual(tokens2);
  });
});
