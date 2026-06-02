/**
 * Security-guard unit tests — C11 SSRF / URL-validation defense-in-depth.
 *
 * Covers:
 *  1. response_url allow-listing (isSlackResponseUrl + postToResponseUrl)
 *  2. safe-fetch IPv6 blocklist additions (multicast, documentation, NAT64)
 *  3. MCP HTTP transport URL validation (validateMcpHttpUrl)
 *  4. CSRF state timing-safe compare (completeOAuth with timingSafeEqual)
 *  5. Malformed MCP inputSchema structural check (McpDispatcher.listAsync)
 */

// Module mocks must be declared before imports (hoisted by vitest).
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return { Client: vi.fn() };
});
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: vi.fn().mockImplementation((opts: unknown) => ({ _opts: opts })),
  };
});

import { Client as MockClient } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { McpDispatcher, MCP_TOOL_SEPARATOR, _resetPoolForTesting } from '../src/mcp/dispatcher.js';
import { validateMcpHttpUrl } from '../src/mcp/inject.js';
import {
  completeOAuth,
  generateState,
  registerPendingAuth,
  _resetRegistryForTesting,
} from '../src/mcp/oauth-registry.js';
import { isBlockedAddress } from '../src/safe-fetch.js';
import { isSlackResponseUrl, postToResponseUrl } from '../src/server-utils.js';

import type { ConnectorConfig } from '../src/mcp/config.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ---------------------------------------------------------------------------
// 1. response_url allow-listing
// ---------------------------------------------------------------------------

describe('isSlackResponseUrl', () => {
  it.each([
    'https://hooks.slack.com/actions/T123/456/abc',
    'https://hooks.slack.com/commands/T123/456/abc',
    'https://hooks.slack.com/services/T123/456/abc',
  ])('allows a valid Slack response_url: %s', (url) => {
    expect(isSlackResponseUrl(url)).toBe(true);
  });

  it.each([
    'http://hooks.slack.com/actions/T123/456/abc', // http not https
    'https://evil.example.com/hooks.slack.com', // hooks.slack.com as path
    'https://hooks.slack.com.evil.com/a/b', // subdomain spoofing
    'https://internal-server.corp/response', // internal host
    'http://169.254.169.254/latest/meta-data/', // metadata endpoint
    '', // empty
    'ftp://hooks.slack.com/whatever', // wrong scheme
  ])('blocks non-Slack URL: %s', (url) => {
    expect(isSlackResponseUrl(url)).toBe(false);
  });
});

describe('postToResponseUrl — SSRF guard', () => {
  it('returns false without fetching when URL is not hooks.slack.com', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await postToResponseUrl('http://169.254.169.254/latest/meta-data/', {
      text: 'hello',
    });
    expect(result).toBe(false);
    // fetch must never have been called
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('calls fetch when URL is valid hooks.slack.com', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const result = await postToResponseUrl('https://hooks.slack.com/actions/T/A/tok', {
      text: 'hello',
    });
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 2. safe-fetch IPv6 blocklist additions
// ---------------------------------------------------------------------------

describe('isBlockedAddress — new IPv6 ranges', () => {
  // RFC 4291 — multicast ff00::/8
  it.each([
    'ff00::1',
    'ff02::1', // all-nodes multicast
    'ff0e::1',
    'ffff::1',
  ])('blocks multicast IPv6 %s (RFC 4291 ff00::/8)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  // RFC 3849 — documentation 2001:db8::/32
  it.each(['2001:db8::1', '2001:db8:1::1', '2001:db8:ffff::ffff'])(
    'blocks documentation IPv6 %s (RFC 3849 2001:db8::/32)',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(true);
    },
  );

  // RFC 6052 — NAT64 well-known prefix 64:ff9b::/96
  it.each([
    '64:ff9b::1',
    '64:ff9b::c000:201', // 192.0.2.1 in NAT64
  ])('blocks NAT64 IPv6 %s (RFC 6052 64:ff9b::/96)', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  // Ensure existing public IPv6 still allowed
  it.each([
    '2606:2800:220:1::1',
    '2001:4860:4860::8888', // Google DNS
    '2a00:1450:4009::1',
  ])('still allows public IPv6 %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. MCP HTTP transport URL validation
// ---------------------------------------------------------------------------

describe('validateMcpHttpUrl', () => {
  it('rejects http:// to a remote non-localhost host', () => {
    expect(() => validateMcpHttpUrl('http://evil.example.com/mcp')).toThrow(/must use https:\/\//);
  });

  it('allows http:// to localhost (local dev)', () => {
    expect(() => validateMcpHttpUrl('http://localhost:3000/mcp')).not.toThrow();
  });

  it('allows http:// to 127.0.0.1 (local dev)', () => {
    expect(() => validateMcpHttpUrl('http://127.0.0.1:4000/mcp')).not.toThrow();
  });

  it('allows http:// to ::1 (IPv6 loopback)', () => {
    expect(() => validateMcpHttpUrl('http://[::1]:3000/mcp')).not.toThrow();
  });

  it('allows https:// to any remote host', () => {
    expect(() => validateMcpHttpUrl('https://mcp.example.com/server')).not.toThrow();
  });

  it('allows https:// to localhost too', () => {
    expect(() => validateMcpHttpUrl('https://localhost:3000/mcp')).not.toThrow();
  });

  it('rejects a malformed URL', () => {
    expect(() => validateMcpHttpUrl('not-a-url')).toThrow(/not a valid URL/);
  });

  it('emits console.warn for a private-IP host (allowed but suspicious)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => validateMcpHttpUrl('https://192.168.1.50/mcp')).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('private/link-local'));
    warnSpy.mockRestore();
  });

  it('does NOT warn for a public HTTPS remote host', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => validateMcpHttpUrl('https://mcp.example.com/server')).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 4. CSRF state timing-safe compare
// ---------------------------------------------------------------------------

describe('completeOAuth — timing-safe CSRF state check', () => {
  const slug = 'test-connector';

  // Stub transport that resolves finishAuth immediately.
  function makeStubTransport(): StreamableHTTPClientTransport {
    return {
      finishAuth: vi.fn().mockResolvedValue(undefined),
    } as unknown as StreamableHTTPClientTransport;
  }

  beforeEach(() => {
    _resetRegistryForTesting();
  });

  afterEach(() => {
    _resetRegistryForTesting();
  });

  it('rejects a mismatched state (CSRF protection)', async () => {
    const state = generateState();
    const transport = makeStubTransport();
    const authorizeUrl = new URL('https://example.com/authorize');
    registerPendingAuth(slug, authorizeUrl, transport, state);

    await expect(completeOAuth(slug, 'valid-code', 'wrong-state-value')).rejects.toThrow(
      /State mismatch/,
    );
  });

  it('rejects a state with correct length but wrong value', async () => {
    const state = generateState(); // 64 hex chars
    // Flip last char to get same-length but different value
    const wrongState = state.slice(0, -1) + (state.endsWith('a') ? 'b' : 'a');
    const transport = makeStubTransport();
    registerPendingAuth(slug, new URL('https://example.com/auth'), transport, state);

    await expect(completeOAuth(slug, 'code', wrongState)).rejects.toThrow(/State mismatch/);
  });

  it('accepts a matching state and completes the flow', async () => {
    const state = generateState();
    const transport = makeStubTransport();
    registerPendingAuth(slug, new URL('https://example.com/auth'), transport, state);

    const result = await completeOAuth(slug, 'auth-code', state);
    expect(result).toBe('ok');
    expect(transport.finishAuth).toHaveBeenCalledWith('auth-code');
  });

  it('rejects a second call with same state (single-use: replay protection)', async () => {
    const state = generateState();
    const transport = makeStubTransport();
    registerPendingAuth(slug, new URL('https://example.com/auth'), transport, state);

    // First call should succeed
    await completeOAuth(slug, 'code', state);
    // Second call should fail — entry was removed
    await expect(completeOAuth(slug, 'code', state)).rejects.toThrow(/No pending authorization/);
  });
});

// ---------------------------------------------------------------------------
// 5. Malformed MCP inputSchema structural check
// ---------------------------------------------------------------------------

describe('McpDispatcher — inputSchema structural validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPoolForTesting();
  });

  afterEach(() => {
    _resetPoolForTesting();
  });

  function makeConnector(name: string): ConnectorConfig {
    return { name, transport: { kind: 'stdio', command: '/bin/srv' } };
  }

  it('skips a tool whose inputSchema is null (handles gracefully, no crash)', async () => {
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'bad_tool', inputSchema: null }],
      }),
      callTool: vi.fn(),
    };
    vi.mocked(MockClient).mockReturnValue(mockClient as unknown as InstanceType<typeof MockClient>);

    const dispatcher = new McpDispatcher([makeConnector('schema-null')]);
    await dispatcher.listAsync();
    // The tool with null schema is skipped — no tools contributed
    expect(dispatcher.list()).toHaveLength(0);
  });

  it('skips a tool whose inputSchema is a string (non-object)', async () => {
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'string_schema', inputSchema: 'not-an-object' }],
      }),
      callTool: vi.fn(),
    };
    vi.mocked(MockClient).mockReturnValue(mockClient as unknown as InstanceType<typeof MockClient>);

    const dispatcher = new McpDispatcher([makeConnector('schema-string')]);
    await dispatcher.listAsync();
    expect(dispatcher.list()).toHaveLength(0);
  });

  it('skips a tool whose inputSchema is an array (non-plain-object)', async () => {
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'array_schema', inputSchema: ['not', 'an', 'object'] }],
      }),
      callTool: vi.fn(),
    };
    vi.mocked(MockClient).mockReturnValue(mockClient as unknown as InstanceType<typeof MockClient>);

    const dispatcher = new McpDispatcher([makeConnector('schema-array')]);
    await dispatcher.listAsync();
    expect(dispatcher.list()).toHaveLength(0);
  });

  it('keeps a valid tool when inputSchema is a proper object', async () => {
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: 'valid_tool',
            description: 'a valid tool',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }),
      callTool: vi.fn(),
    };
    vi.mocked(MockClient).mockReturnValue(mockClient as unknown as InstanceType<typeof MockClient>);

    const dispatcher = new McpDispatcher([makeConnector('schema-valid')]);
    await dispatcher.listAsync();
    const tools = dispatcher.list();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe(`schema-valid${MCP_TOOL_SEPARATOR}valid_tool`);
  });

  it('keeps valid tools while skipping invalid ones in the same server', async () => {
    const mockClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({
        tools: [
          { name: 'bad', inputSchema: 42 },
          { name: 'good', description: 'ok', inputSchema: { type: 'object', properties: {} } },
          { name: 'also_bad', inputSchema: null },
        ],
      }),
      callTool: vi.fn(),
    };
    vi.mocked(MockClient).mockReturnValue(mockClient as unknown as InstanceType<typeof MockClient>);

    const dispatcher = new McpDispatcher([makeConnector('mixed')]);
    await dispatcher.listAsync();
    const tools = dispatcher.list();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe(`mixed${MCP_TOOL_SEPARATOR}good`);
  });
});
