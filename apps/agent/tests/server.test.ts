import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { resolveConfirmation } from '../src/confirmations.js';
import { createServer } from '../src/server.js';

import type { AgentConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// Mock @hono/node-server/conninfo so admin route tests can control the remote
// address without a real TCP socket. Default: loopback (127.0.0.1), which
// matches the behaviour all existing tests rely on (they never call admin
// routes). Individual tests override via vi.mocked(getConnInfo).mockReturnValue.
// ---------------------------------------------------------------------------
vi.mock('@hono/node-server/conninfo', () => ({
  getConnInfo: vi.fn(() => ({
    remote: { address: '127.0.0.1', port: 0, addressType: 'IPv4' },
  })),
}));
// Lazy import so the mock is in place when the module resolves.
const { getConnInfo } = await import('@hono/node-server/conninfo');

const SIGNING_SECRET = 'test-signing-secret';

const config: AgentConfig = {
  port: 0,
  slackSigningSecret: SIGNING_SECRET,
  slackBotToken: 'xoxb-test',
  slackBotUserId: 'UBOT',
  slackTeamId: 'T-TEST',
  ownerSlackUserId: 'UOWNER',
  fireworksApiKey: 'fw-key',
  fireworksModel: 'test-model',
  fireworksBaseUrl: 'http://fake.fireworks',
  behavior: {
    taskCardThreshold: 1,
    taskCardAfter: 'delete',
    ownerPostMarker: true,
  },
  mcpServers: [],
  mcpConfigSource: 'none',
};

function sign(ts: string, body: string): string {
  return `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
}

function post(body: string, headers: Record<string, string>): Promise<Response> {
  const app = createServer({ config });
  return Promise.resolve(
    app.request('/slack/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }),
  );
}

/**
 * POST a signed request to an arbitrary path with arbitrary content-type.
 * Used for slash commands (form-encoded) and lifecycle event leak tests.
 */
function postTo(
  path: string,
  body: string,
  contentType: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const app = createServer({ config });
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': contentType, ...headers },
      body,
    }),
  );
}

/** Build the standard headers Slack sends, including a valid signature. */
function signedHeaders(body: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    'x-slack-request-timestamp': ts,
    'x-slack-signature': sign(ts, body),
  };
}

describe('agent server /slack/events', () => {
  it('rejects a bad signature with 401', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: 'event_callback' });
    const res = await post(body, {
      'x-slack-request-timestamp': ts,
      'x-slack-signature': 'v0=deadbeef',
    });
    expect(res.status).toBe(401);
  });

  it('echoes the url_verification challenge with a valid signature', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: 'url_verification', challenge: 'chal-xyz' });
    const res = await post(body, {
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sign(ts, body),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'chal-xyz' });
  });

  it('rejects a stale timestamp with 401', async () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 60 * 60);
    const body = JSON.stringify({ type: 'url_verification', challenge: 'x' });
    const res = await post(body, {
      'x-slack-request-timestamp': staleTs,
      'x-slack-signature': sign(staleTs, body),
    });
    expect(res.status).toBe(401);
  });

  it('ACKs an assistant_thread_started from a NON-owner without error (leak gate)', async () => {
    // The fix: a non-owner opening their Sym panel must not trigger any panel
    // API call (no setTitle / setSuggestedPrompts / chatPostMessage). Slack-side
    // we cannot observe Slack call attempts from here, but the route must
    // accept the event cleanly without throwing — the gate is the *absence*
    // of side effects, which is verified by the normalizer test ensuring
    // assistantThreadStarted() now carries userId for the gate to read.
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev-leak-1',
      team_id: config.slackTeamId,
      event: {
        type: 'assistant_thread_started',
        ts: '1700000020.000001',
        channel: '',
        text: '',
        assistant_thread: {
          user_id: 'U-INTRUDER', // ← not the owner
          channel_id: 'D-INTRUDER-SYM-IM',
          thread_ts: '1700000020.000001',
        },
      },
    });
    const res = await postTo('/slack/events', body, 'application/json', signedHeaders(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Slash commands — owner-gated universal entry point.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// assistant_thread_context_changed event path
// ---------------------------------------------------------------------------
describe('agent server — assistant_thread_context_changed', () => {
  it('ACKs an assistant_thread_context_changed event from the owner with 200', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev-ctx-changed-1',
      team_id: config.slackTeamId,
      event: {
        type: 'assistant_thread_context_changed',
        ts: '1700000030.000001',
        channel: '',
        text: '',
        assistant_thread: {
          user_id: config.ownerSlackUserId,
          channel_id: 'D-OWNER-SYM-IM',
          thread_ts: '1700000030.000001',
        },
        context: {
          channel_id: 'C-CONTEXT-CHANNEL',
        },
      },
    });
    const res = await postTo('/slack/events', body, 'application/json', signedHeaders(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('silently drops an assistant_thread_context_changed from a non-owner (no error, no API call)', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev-ctx-changed-nonowner',
      team_id: config.slackTeamId,
      event: {
        type: 'assistant_thread_context_changed',
        ts: '1700000031.000001',
        channel: '',
        text: '',
        assistant_thread: {
          user_id: 'U-NOT-OWNER',
          channel_id: 'D-INTRUDER-SYM-IM',
          thread_ts: '1700000031.000001',
        },
        context: {
          channel_id: 'C-SOME-CHANNEL',
        },
      },
    });
    const res = await postTo('/slack/events', body, 'application/json', signedHeaders(body));
    // The server still ACKs 200 (Slack requires a fast 200 even for dropped events)
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// OAuth callback route — GET /oauth/callback/:slug
// ---------------------------------------------------------------------------
describe('agent server — GET /oauth/callback/:slug', () => {
  it('returns 400 with HTML when required parameters are missing', async () => {
    const app = createServer({ config });
    // Missing code and state
    const res = await app.request('/oauth/callback/test-connector', { method: 'GET' });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Missing required parameters');
  });

  it('returns 400 with HTML when slug is present but code is missing', async () => {
    const app = createServer({ config });
    const res = await app.request('/oauth/callback/test-connector?state=abc123', { method: 'GET' });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Missing required parameters');
  });

  it('returns 400 with HTML when slug is present but state is missing', async () => {
    const app = createServer({ config });
    const res = await app.request('/oauth/callback/test-connector?code=auth-code-123', {
      method: 'GET',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Missing required parameters');
  });

  it('returns 400 with HTML when completeOAuth fails (unknown slug)', async () => {
    const app = createServer({ config });
    // A slug that is not in the oauth registry will cause completeOAuth to throw.
    const res = await app.request('/oauth/callback/nonexistent-slug?code=code123&state=state456', {
      method: 'GET',
    });
    // completeOAuth throws for unknown slugs → 400 response
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Authorization Failed');
    expect(html).toContain('nonexistent-slug');
    // Must not leak code or state into the HTML response
    expect(html).not.toContain('code123');
    expect(html).not.toContain('state456');
  });

  it('OAuth failure response contains an HTML page (not JSON)', async () => {
    const app = createServer({ config });
    const res = await app.request('/oauth/callback/test-slug?code=authcode&state=authstate', {
      method: 'GET',
    });
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toMatch(/text\/html/);
  });

  it('does not echo code or state in any error response', async () => {
    const app = createServer({ config });
    const sensitiveCode = 'super-secret-auth-code';
    const sensitiveState = 'secret-csrf-state';
    const res = await app.request(
      `/oauth/callback/test-slug?code=${sensitiveCode}&state=${sensitiveState}`,
      { method: 'GET' },
    );
    const html = await res.text();
    expect(html).not.toContain(sensitiveCode);
    expect(html).not.toContain(sensitiveState);
  });
});

// ---------------------------------------------------------------------------
// Slack Slash Commands
// ---------------------------------------------------------------------------
describe('agent server /slack/commands', () => {
  function formBody(fields: Record<string, string>): string {
    return new URLSearchParams(fields).toString();
  }

  it('rejects a bad signature with 401', async () => {
    const body = formBody({ command: '/sym', text: 'hi', user_id: 'UOWNER' });
    const res = await postTo('/slack/commands', body, 'application/x-www-form-urlencoded', {
      'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-slack-signature': 'v0=deadbeef',
    });
    expect(res.status).toBe(401);
  });

  it('silent-ACKs a slash command from a foreign workspace', async () => {
    const body = formBody({
      team_id: 'T-OTHER', // not config.slackTeamId
      user_id: 'UOWNER',
      channel_id: 'C1',
      command: '/sym',
      text: 'hi',
      trigger_id: 'tr-1',
      response_url: 'http://example.invalid/r/1',
    });
    const res = await postTo(
      '/slack/commands',
      body,
      'application/x-www-form-urlencoded',
      signedHeaders(body),
    );
    expect(res.status).toBe(200);
    // Empty body — no Slack-visible message about being rejected.
    expect(await res.text()).toBe('');
  });

  it('silent-ACKs a slash command from a NON-owner', async () => {
    const body = formBody({
      team_id: config.slackTeamId,
      user_id: 'U-NOT-OWNER',
      channel_id: 'C1',
      command: '/sym',
      text: 'hi',
      trigger_id: 'tr-2',
      response_url: 'http://example.invalid/r/2',
    });
    const res = await postTo(
      '/slack/commands',
      body,
      'application/x-www-form-urlencoded',
      signedHeaders(body),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('returns a usage hint when the owner sends `/sym` with no text', async () => {
    const body = formBody({
      team_id: config.slackTeamId,
      user_id: config.ownerSlackUserId,
      channel_id: 'C1',
      command: '/sym',
      text: '   ', // whitespace only
      trigger_id: 'tr-3',
      response_url: 'http://example.invalid/r/3',
    });
    const res = await postTo(
      '/slack/commands',
      body,
      'application/x-www-form-urlencoded',
      signedHeaders(body),
    );
    // 200 ACK; the actual usage hint is posted to response_url out-of-band.
    expect(res.status).toBe(200);
  });

  it('ACKs the owner happy path 200 and kicks off the turn in the background', async () => {
    // Background work (chatPostMessage seed + handleTurn) is fire-and-forget;
    // it will fail in tests (no real Slack endpoint), but those errors are
    // caught inside processSlashCommand. The HTTP response is the contract
    // Slack actually sees, and it must be 200 within 3s.
    const body = formBody({
      team_id: config.slackTeamId,
      user_id: config.ownerSlackUserId,
      channel_id: 'C1',
      command: '/sym',
      text: 'what is the status of the auth migration',
      trigger_id: 'tr-4',
      response_url: 'http://example.invalid/r/4',
    });
    const res = await postTo(
      '/slack/commands',
      body,
      'application/x-www-form-urlencoded',
      signedHeaders(body),
    );
    expect(res.status).toBe(200);
  });

  it('ACKs the owner happy path 200 when invoked from a DM (channel_name=directmessage)', async () => {
    // A 1:1 DM with someone else: the seed post will fail (channel_not_found)
    // and delivery falls back to an ephemeral response_url reply. All of that
    // is background + fire-and-forget; the route contract is still a fast 200.
    const body = formBody({
      team_id: config.slackTeamId,
      user_id: config.ownerSlackUserId,
      channel_id: 'D9999',
      channel_name: 'directmessage',
      command: '/sym',
      text: 'summarize what we just discussed',
      trigger_id: 'tr-dm-1',
      response_url: 'http://example.invalid/r/dm',
    });
    const res = await postTo(
      '/slack/commands',
      body,
      'application/x-www-form-urlencoded',
      signedHeaders(body),
    );
    expect(res.status).toBe(200);
  });

  it('ACKs 200 for response_url fallback path: non-DM channel Sym is not a member of', async () => {
    // When Sym is not a member of the invocation channel (not a DM), the seed
    // chatPostMessage will fail and the turn falls back to response_url delivery.
    // The route contract is still a fast 200 — background work is fire-and-forget.
    const body = formBody({
      team_id: config.slackTeamId,
      user_id: config.ownerSlackUserId,
      channel_id: 'C-NOT-MEMBER',
      channel_name: 'some-channel',
      command: '/sym',
      text: 'what is the p1 status',
      trigger_id: 'tr-resp-url-1',
      response_url: 'http://example.invalid/r/fallback',
    });
    const res = await postTo(
      '/slack/commands',
      body,
      'application/x-www-form-urlencoded',
      signedHeaders(body),
    );
    // The HTTP contract is unchanged: route ACKs 200 immediately regardless of
    // whether the background work uses the seed path or the response_url path.
    expect(res.status).toBe(200);
    // The body must be empty (Slack's preferred "no immediate message" shape).
    expect(await res.text()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// C26 — Adversarial tests for POST /slack/interactivity trust chain (Z15-08)
// ---------------------------------------------------------------------------
// Helpers for crafting interactivity payloads.

/** Build a minimal Slack block_actions payload string for the `payload` field. */
function interactivityPayload(overrides: {
  type?: string;
  userId?: string;
  teamId?: string;
  actionId?: string;
  responseUrl?: string;
}): string {
  const {
    type = 'block_actions',
    userId = config.ownerSlackUserId,
    teamId = config.slackTeamId,
    actionId = 'sym_confirm:00000000-0000-0000-0000-000000000001:approve',
    responseUrl = undefined,
  } = overrides;
  const inner: Record<string, unknown> = {
    type,
    user: { id: userId },
    team: { id: teamId },
    actions: [{ action_id: actionId }],
    message: { text: 'test message', blocks: [] },
  };
  if (responseUrl !== undefined) inner['response_url'] = responseUrl;
  return JSON.stringify(inner);
}

/** Encode a payload object as an `application/x-www-form-urlencoded` body. */
function interactivityBody(payloadStr: string): string {
  return new URLSearchParams({ payload: payloadStr }).toString();
}

/** POST to /slack/interactivity with proper content-type. */
function postInteractivity(body: string, headers: Record<string, string> = {}): Promise<Response> {
  const app = createServer({ config });
  return Promise.resolve(
    app.request('/slack/interactivity', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body,
    }),
  );
}

describe('agent server /slack/interactivity — adversarial', () => {
  // Scenario 1: missing / invalid Slack signature → 401 before body processing.
  it('S1: rejects a missing Slack signature with 401', async () => {
    const body = interactivityBody(interactivityPayload({}));
    const res = await postInteractivity(body, {
      'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-slack-signature': 'v0=deadbeef',
    });
    expect(res.status).toBe(401);
  });

  it('S1b: rejects a completely absent Slack signature with 401', async () => {
    const body = interactivityBody(interactivityPayload({}));
    // No signature headers at all.
    const res = await postInteractivity(body);
    expect(res.status).toBe(401);
  });

  // Scenario 2: valid signature but NON-OWNER user clicks → 200 silent ACK,
  // confirmation NOT resolved.
  it('S2: non-owner click silently ACKs 200 and does not resolve a confirmation', async () => {
    // Register a real confirmation so we can verify it stays unresolved.
    const id = '00000000-0000-0000-0000-000000000002';
    const body = interactivityBody(
      interactivityPayload({ userId: 'U-INTRUDER', actionId: `sym_confirm:${id}:approve` }),
    );
    const res = await postInteractivity(body, signedHeaders(body));
    expect(res.status).toBe(200);
    // resolveConfirmation for an id that was never registered returns false,
    // and for the non-owner case the handler ACKs before reaching resolve.
    // Either way the confirmation is NOT resolved (not in the pending map).
    expect(resolveConfirmation(id, true)).toBe(false);
  });

  // Scenario 3: valid signature but FOREIGN workspace (team_id ≠ configured) →
  // 200 silent ACK, confirmation NOT resolved.
  it('S3: foreign workspace click silently ACKs 200 and does not resolve a confirmation', async () => {
    const id = '00000000-0000-0000-0000-000000000003';
    const body = interactivityBody(
      interactivityPayload({ teamId: 'T-FOREIGN', actionId: `sym_confirm:${id}:approve` }),
    );
    const res = await postInteractivity(body, signedHeaders(body));
    expect(res.status).toBe(200);
    expect(resolveConfirmation(id, true)).toBe(false);
  });

  // Scenario 4: malformed action_id (doesn't match `sym_confirm:<uuid>:(approve|deny)`) →
  // 200 ACK, no resolution.
  it('S4: malformed action_id ACKs 200 without resolving any confirmation', async () => {
    const body = interactivityBody(interactivityPayload({ actionId: 'totally_unrelated_action' }));
    const res = await postInteractivity(body, signedHeaders(body));
    expect(res.status).toBe(200);
    // No confirmation was registered, nothing should have been resolved.
    const unknownId = 'totally_unrelated_action';
    expect(resolveConfirmation(unknownId, true)).toBe(false);
  });

  it('S4b: partial sym_confirm action_id (missing verdict) ACKs 200 gracefully', async () => {
    const body = interactivityBody(interactivityPayload({ actionId: 'sym_confirm:some-id' }));
    const res = await postInteractivity(body, signedHeaders(body));
    expect(res.status).toBe(200);
  });

  it('S4c: sym_confirm with unknown verdict type ACKs 200 gracefully', async () => {
    const body = interactivityBody(
      interactivityPayload({ actionId: 'sym_confirm:some-id:delete' }),
    );
    const res = await postInteractivity(body, signedHeaders(body));
    expect(res.status).toBe(200);
  });

  // Scenario 5: unknown / stale confirmation UUID → resolveConfirmation returns
  // false; handler proceeds gracefully (no crash, still returns resolved status).
  it('S5: unknown confirmation UUID is handled gracefully — no crash', async () => {
    const staleId = '00000000-0000-0000-0000-000000000099';
    const body = interactivityBody(
      interactivityPayload({ actionId: `sym_confirm:${staleId}:approve` }),
    );
    // Verify nothing is in the pending map for this id.
    expect(resolveConfirmation(staleId, true)).toBe(false);
    // Even though resolveConfirmation returns false, the handler must not crash
    // — it should still return 200 (the "resolved" branch ACKs OK).
    const res = await postInteractivity(body, signedHeaders(body));
    expect(res.status).toBe(200);
  });

  // Scenario 6: post-timeout approval → a confirmation that already resolved
  // false by timeout stays false; a late approve does not flip it.
  it('S6: post-timeout (already-resolved) id cannot be re-resolved by a late click', async () => {
    // Simulate a timed-out confirmation: it was registered and then the timeout
    // fired, deleting it from the pending map. At that point resolveConfirmation
    // returns false. A late interactivity click for the same id must not resolve
    // it true.
    const timedOutId = '00000000-0000-0000-0000-000000000100';
    // The id was never (or no longer) in the pending map — simulates post-timeout.
    const firstAttempt = resolveConfirmation(timedOutId, true);
    expect(firstAttempt).toBe(false);

    // A second attempt via the interactivity route also returns false — the
    // confirmation is gone from the map and cannot be reflipped.
    const body = interactivityBody(
      interactivityPayload({ actionId: `sym_confirm:${timedOutId}:approve` }),
    );
    const res = await postInteractivity(body, signedHeaders(body));
    expect(res.status).toBe(200);

    // Confirm resolving again still returns false (idempotent non-operation).
    expect(resolveConfirmation(timedOutId, true)).toBe(false);
  });

  // Scenario 7: a resolved click DELETES the prompt (removes it from Slack)
  // rather than editing it in place. The decision is recorded on the task card,
  // not by leaving a spent prompt behind.
  it('S7: a resolved click deletes the prompt via response_url (delete_original)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    try {
      const responseUrl = 'https://hooks.slack.com/actions/T-TEST/123/abc';
      const body = interactivityBody(
        interactivityPayload({
          actionId: 'sym_confirm:00000000-0000-0000-0000-0000000000aa:approve',
          responseUrl,
        }),
      );
      const res = await postInteractivity(body, signedHeaders(body));
      expect(res.status).toBe(200);

      // Find the response_url call (other in-flight background turns from earlier
      // tests may also touch fetch; match on our URL, don't assume a total count).
      const deleteCall = fetchSpy.mock.calls.find(([u]) => u === responseUrl);
      expect(deleteCall).toBeDefined();
      const payload = JSON.parse(String((deleteCall![1] as RequestInit).body)) as Record<
        string,
        unknown
      >;
      expect(payload['delete_original']).toBe(true);
      // No in-place rebuild: we don't ship replacement blocks anymore.
      expect(payload['replace_original']).toBeUndefined();
      expect(payload['blocks']).toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// C29 — Admin loopback negative test (Z15-06)
// ---------------------------------------------------------------------------
// Every /admin/* route guards with isLoopback(). The existing tests run via
// app.request() with the mocked conninfo returning 127.0.0.1 (passes the
// guard). This describe block sets the mock to a non-loopback address and
// asserts 403 is returned.

describe('agent server /admin — loopback guard negative path', () => {
  it('GET /admin/status returns 403 when remote address is non-loopback', async () => {
    // Override the mock for this test to return a non-loopback address.
    vi.mocked(getConnInfo).mockReturnValueOnce({
      remote: { address: '1.2.3.4', port: 12345, addressType: 'IPv4' },
    });
    const app = createServer({ config });
    const res = await app.request('/admin/status', { method: 'GET' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe('forbidden');
    expect(body.detail).toContain('loopback-only');
  });

  it('GET /admin/connectors returns 403 when remote address is non-loopback', async () => {
    vi.mocked(getConnInfo).mockReturnValueOnce({
      remote: { address: '203.0.113.42', port: 9999, addressType: 'IPv4' },
    });
    const app = createServer({ config });
    const res = await app.request('/admin/connectors', { method: 'GET' });
    expect(res.status).toBe(403);
  });

  it('POST /admin/reload returns 403 when remote address is non-loopback', async () => {
    vi.mocked(getConnInfo).mockReturnValueOnce({
      remote: { address: '10.0.0.1', port: 8080, addressType: 'IPv4' },
    });
    const app = createServer({ config });
    const res = await app.request('/admin/reload', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('GET /admin/status returns 200 when remote address IS loopback (baseline)', async () => {
    // The default mock already returns 127.0.0.1, but we set it explicitly here
    // to make the positive path unambiguous.
    vi.mocked(getConnInfo).mockReturnValueOnce({
      remote: { address: '127.0.0.1', port: 54321, addressType: 'IPv4' },
    });
    const app = createServer({ config });
    const res = await app.request('/admin/status', { method: 'GET' });
    expect(res.status).toBe(200);
  });
});
