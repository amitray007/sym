/**
 * Tests for workspace-context.ts — loadWorkspaceContext + healthCheckTokens.
 *
 * loadWorkspaceContext builds the single-tenant runtime context from an AgentConfig.
 * healthCheckTokens verifies both tokens (auth.test) and resolves the owner profile.
 */

import { describe, expect, it } from 'vitest';

import { healthCheckTokens, loadWorkspaceContext } from '../src/workspace-context.js';

import type { AgentConfig } from '../src/config.js';
import type { SlackClient, SlackUserProfile } from '@sym/adapter-slack';
import type { SlackChannelId, SlackThreadTs, SlackUserId } from '@sym/contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    port: 3001,
    slackSigningSecret: 'signing-secret',
    slackBotToken: 'xoxb-bot-token',
    slackBotUserId: 'UBOT001',
    slackTeamId: 'T-WORKSPACE',
    ownerSlackUserId: 'U-OWNER',
    fireworksApiKey: 'fw-api-key',
    fireworksModel: 'accounts/fireworks/models/test-model',
    fireworksBaseUrl: 'https://api.fireworks.ai/inference/v1',
    behavior: {
      taskCardThreshold: 1,
      taskCardAfter: 'delete',
      ownerPostMarker: true,
    },
    mcpServers: [],
    mcpConfigSource: 'none',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// loadWorkspaceContext
// ---------------------------------------------------------------------------

describe('loadWorkspaceContext', () => {
  it('builds a WorkspaceContext with the expected fields from config', () => {
    const config = makeConfig();
    const ctx = loadWorkspaceContext(config);
    // Core identity fields
    expect(ctx.workspaceId).toBe('T-WORKSPACE');
    expect(ctx.slackTeamId).toBe('T-WORKSPACE');
    expect(ctx.botUserId).toBe('UBOT001');
    expect(ctx.ownerSlackUserId).toBe('U-OWNER');
    // Model
    expect(ctx.model).toBe('accounts/fireworks/models/test-model');
    // Fireworks credentials
    expect(ctx.fireworks.baseUrl).toBe('https://api.fireworks.ai/inference/v1');
    expect(ctx.fireworks.apiKey).toBe('fw-api-key');
    // Slack client must be present
    expect(ctx.slackClient).toBeDefined();
    // Name resolver must be present
    expect(ctx.nameResolver).toBeDefined();
    // MCP servers
    expect(ctx.mcpServers).toEqual([]);
  });

  it('creates a bot SlackClient (slackClient is always present)', () => {
    const ctx = loadWorkspaceContext(makeConfig());
    expect(ctx.slackClient).toBeDefined();
    expect(typeof ctx.slackClient.authTest).toBe('function');
  });

  it('does NOT create a userSlackClient when SLACK_OWNER_USER_TOKEN is absent', () => {
    const config = makeConfig();
    // No slackUserToken property
    expect(config.slackUserToken).toBeUndefined();
    const ctx = loadWorkspaceContext(config);
    expect(ctx.userSlackClient).toBeUndefined();
  });

  it('creates a userSlackClient when slackUserToken is present', () => {
    const config = makeConfig({ slackUserToken: 'xoxp-user-token' });
    const ctx = loadWorkspaceContext(config);
    expect(ctx.userSlackClient).toBeDefined();
    expect(typeof ctx.userSlackClient?.authTest).toBe('function');
  });

  it('ownerProfile is absent immediately after construction (resolved async later)', () => {
    const ctx = loadWorkspaceContext(makeConfig());
    // healthCheckTokens mutates ownerProfile in place; before it runs, it's absent.
    expect(ctx.ownerProfile).toBeUndefined();
  });

  it('nameResolver is a fresh NameResolver instance (starts empty)', () => {
    const ctx = loadWorkspaceContext(makeConfig());
    // A fresh resolver has no cached names — getUser should return undefined.
    expect(ctx.nameResolver.getUser('U999')).toBeUndefined();
  });

  it('passes mcpServers from config through to context', () => {
    const mcpServers = [
      {
        name: 'test-connector',
        transport: { kind: 'http' as const, url: 'https://mcp.example.com' },
      },
    ];
    const ctx = loadWorkspaceContext(makeConfig({ mcpServers }));
    expect(ctx.mcpServers).toHaveLength(1);
    expect(ctx.mcpServers[0]?.name).toBe('test-connector');
  });
});

// ---------------------------------------------------------------------------
// healthCheckTokens
// ---------------------------------------------------------------------------

/** Minimal fake SlackClient for healthCheckTokens tests. */
function makeFakeSlackClient(opts: {
  authResult?: { userId: SlackUserId; teamId: string; user?: string };
  authError?: Error;
  userProfile?: SlackUserProfile;
  profileError?: Error;
}): SlackClient {
  return {
    async authTest() {
      if (opts.authError !== undefined) throw opts.authError;
      return opts.authResult ?? { userId: 'U0' as SlackUserId, teamId: 'T0' };
    },
    async usersInfo(): Promise<SlackUserProfile> {
      if (opts.profileError !== undefined) throw opts.profileError;
      return opts.userProfile ?? { id: 'U0' as SlackUserId };
    },
    async conversationsHistory() {
      return { messages: [] };
    },
    async conversationsReplies() {
      return { messages: [] };
    },
    async usersList() {
      return { users: [] };
    },
    async conversationsList() {
      return { channels: [] };
    },
    async conversationsInfo(params) {
      return { id: params.channel, isIm: false, isMpim: false };
    },
    async chatPostMessage(params) {
      return { ts: '1.0' as SlackThreadTs, channel: params.channel };
    },
    async chatUpdate() {
      /* no-op */
    },
    async reactionsAdd() {
      /* no-op */
    },
    async assistantThreadsSetStatus() {
      /* no-op */
    },
    async assistantThreadsSetSuggestedPrompts() {
      /* no-op */
    },
    async assistantThreadsSetTitle() {
      /* no-op */
    },
    async chatStartStream() {
      return {
        channel: 'C1' as SlackChannelId,
        ts: '0.0' as SlackThreadTs,
      };
    },
    async chatAppendStream() {
      /* no-op */
    },
    async chatStopStream() {
      /* no-op */
    },
    async chatDelete() {
      /* no-op */
    },
    async searchMessages() {
      return { matches: [], total: 0 };
    },
    async usersProfileSet() {
      /* no-op */
    },
    async remindersAdd(params) {
      return { id: 'Rm1', text: params.text };
    },
  };
}

describe('healthCheckTokens', () => {
  it('resolves owner profile onto ctx when auth + usersInfo succeed', async () => {
    const config = makeConfig();
    const ctx = loadWorkspaceContext(config);
    // Override the slackClient with a fake that returns a known profile.
    const fakeClient = makeFakeSlackClient({
      authResult: { userId: 'UBOT001' as SlackUserId, teamId: 'T-WORKSPACE' },
      userProfile: {
        id: 'U-OWNER' as SlackUserId,
        displayName: 'Amit Ray',
        userName: 'amit',
        tz: 'America/Los_Angeles',
        title: 'Founder',
      },
    });
    ctx.slackClient = fakeClient;

    await healthCheckTokens(ctx);

    // ownerProfile must now be populated
    expect(ctx.ownerProfile).toBeDefined();
    expect(ctx.ownerProfile?.userId).toBe('U-OWNER');
    expect(ctx.ownerProfile?.displayName).toBe('Amit Ray');
    expect(ctx.ownerProfile?.tz).toBe('America/Los_Angeles');
  });

  it('leaves ownerProfile undefined when usersInfo throws (graceful degradation)', async () => {
    const config = makeConfig();
    const ctx = loadWorkspaceContext(config);
    const fakeClient = makeFakeSlackClient({
      authResult: { userId: 'UBOT001' as SlackUserId, teamId: 'T-WORKSPACE' },
      profileError: new Error('user_not_found'),
    });
    ctx.slackClient = fakeClient;

    // healthCheckTokens must not throw even when profile lookup fails.
    await expect(healthCheckTokens(ctx)).resolves.toBeUndefined();
    // ownerProfile remains absent
    expect(ctx.ownerProfile).toBeUndefined();
  });

  it('does not throw when bot authTest fails (logs the error, continues)', async () => {
    const config = makeConfig();
    const ctx = loadWorkspaceContext(config);
    const fakeClient = makeFakeSlackClient({
      authError: new Error('invalid_auth'),
    });
    ctx.slackClient = fakeClient;

    // Should not throw — failures are logged, not propagated.
    await expect(healthCheckTokens(ctx)).resolves.toBeUndefined();
  });

  it('checks user token when userSlackClient is present', async () => {
    const config = makeConfig({ slackUserToken: 'xoxp-user-token' });
    const ctx = loadWorkspaceContext(config);
    // Replace both clients with fakes.
    const botClient = makeFakeSlackClient({
      authResult: { userId: 'UBOT001' as SlackUserId, teamId: 'T-WORKSPACE' },
      userProfile: {
        id: 'U-OWNER' as SlackUserId,
        displayName: 'Amit Ray',
      },
    });
    const userClient = makeFakeSlackClient({
      authResult: { userId: 'U-OWNER' as SlackUserId, teamId: 'T-WORKSPACE' },
      userProfile: {
        id: 'U-OWNER' as SlackUserId,
        displayName: 'Amit Ray',
      },
    });
    ctx.slackClient = botClient;
    ctx.userSlackClient = userClient;

    await expect(healthCheckTokens(ctx)).resolves.toBeUndefined();
    // Owner profile should be resolved (via userSlackClient, which is preferred).
    expect(ctx.ownerProfile).toBeDefined();
  });

  it('does not throw when user token authTest fails (continues with degraded user-tools)', async () => {
    const config = makeConfig({ slackUserToken: 'xoxp-user-token' });
    const ctx = loadWorkspaceContext(config);
    const botClient = makeFakeSlackClient({
      authResult: { userId: 'UBOT001' as SlackUserId, teamId: 'T-WORKSPACE' },
      userProfile: { id: 'U-OWNER' as SlackUserId },
    });
    const userClient = makeFakeSlackClient({
      authError: new Error('token_revoked'),
    });
    ctx.slackClient = botClient;
    ctx.userSlackClient = userClient;

    // Must not throw — user token failure degrades but doesn't crash.
    await expect(healthCheckTokens(ctx)).resolves.toBeUndefined();
  });

  it('uses console.info for bot token OK log (not console.log)', async () => {
    const config = makeConfig();
    const ctx = loadWorkspaceContext(config);
    const fakeClient = makeFakeSlackClient({
      authResult: { userId: 'UBOT001' as SlackUserId, teamId: 'T-WORKSPACE', user: 'sym' },
      userProfile: { id: 'U-OWNER' as SlackUserId },
    });
    ctx.slackClient = fakeClient;

    const infoCalls: string[] = [];
    const logCalls: string[] = [];
    const originalInfo = console.info;
    const originalLog = console.log;
    console.info = (msg: string, ...args: unknown[]) => {
      infoCalls.push(typeof msg === 'string' ? msg : String(msg));
      void args;
    };
    console.log = (msg: string, ...args: unknown[]) => {
      logCalls.push(typeof msg === 'string' ? msg : String(msg));
      void args;
    };
    try {
      await healthCheckTokens(ctx);
      // Boot/runtime logs must use console.info, not console.log
      // (the sym CLI's --json mode spies on console.log for JSON output).
      const infoText = infoCalls.join('\n');
      expect(infoText).toMatch(/bot token OK/);
      // console.log must NOT contain any agent boot messages
      expect(logCalls.join('\n')).not.toMatch(/bot token/);
    } finally {
      console.info = originalInfo;
      console.log = originalLog;
    }
  });
});
