import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadAgentConfig } from '../src/config.js';

const REQUIRED: Record<string, string> = {
  SLACK_SIGNING_SECRET: 's',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_BOT_USER_ID: 'UBOT',
  SLACK_TEAM_ID: 'T1',
  SYM_OWNER_SLACK_USER_ID: 'UOWNER',
  FIREWORKS_API_KEY: 'fw',
  FIREWORKS_MODEL: 'accounts/fireworks/models/x',
};

const CURSOR_KEYS = [
  'CURSOR_API_KEY',
  'CURSOR_MODEL',
  'SYM_CLOUD_DB_PATH',
  'SYM_CLOUD_AGENT_CONFIRM',
];

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = process.env;
  process.env = { ...process.env };
  for (const [k, v] of Object.entries(REQUIRED)) process.env[k] = v;
  for (const k of CURSOR_KEYS) delete process.env[k];
});

afterEach(() => {
  process.env = saved;
});

describe('loadAgentConfig — cursor gating', () => {
  it('omits cursor config when CURSOR_API_KEY is unset', () => {
    expect(loadAgentConfig().cursor).toBeUndefined();
  });

  it('omits cursor config when CURSOR_API_KEY is whitespace-only', () => {
    process.env['CURSOR_API_KEY'] = '   ';
    expect(loadAgentConfig().cursor).toBeUndefined();
  });

  it('populates cursor config with the model default when CURSOR_API_KEY is set', () => {
    process.env['CURSOR_API_KEY'] = 'crsr-abc';
    const cursor = loadAgentConfig().cursor;
    expect(cursor?.apiKey).toBe('crsr-abc');
    expect(cursor?.model).toBe('composer-2.5');
    expect(cursor?.repoAllowlist).toEqual([]);
  });

  it('honors CURSOR_MODEL override', () => {
    process.env['CURSOR_API_KEY'] = 'crsr-abc';
    process.env['CURSOR_MODEL'] = 'claude-opus-4-8';
    expect(loadAgentConfig().cursor?.model).toBe('claude-opus-4-8');
  });

  it('defaults cloudAgentConfirm to true and respects an explicit off value', () => {
    process.env['CURSOR_API_KEY'] = 'crsr-abc';
    expect(loadAgentConfig().behavior.cloudAgentConfirm).toBe(true);
    process.env['SYM_CLOUD_AGENT_CONFIRM'] = 'false';
    expect(loadAgentConfig().behavior.cloudAgentConfirm).toBe(false);
  });
});
