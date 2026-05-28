import { describe, expect, it } from 'vitest';

import { buildOwnerDeclineMessage, checkOwnerAccess, denyReason } from '../src/owner-gate.js';

import type { SlackUserId } from '@sym/contracts';
import type { OwnerIdentity } from '@sym/kernel';

const OWNER = 'U_OWNER' as SlackUserId;
const OTHER = 'U_OTHER' as SlackUserId;

describe('checkOwnerAccess', () => {
  it('allows the owner', () => {
    expect(checkOwnerAccess(OWNER, OWNER)).toBe('allow');
  });

  it('denies a non-owner', () => {
    expect(checkOwnerAccess(OTHER, OWNER)).toBe('deny');
  });

  it('fails closed when the owner is unset (denies everyone, including a match attempt)', () => {
    expect(checkOwnerAccess(OWNER, null)).toBe('deny');
    expect(checkOwnerAccess(OTHER, null)).toBe('deny');
  });
});

describe('denyReason', () => {
  it('is owner_unset when no owner is configured', () => {
    expect(denyReason(null)).toBe('owner_unset');
  });

  it('is not_owner when an owner exists but the requester differs', () => {
    expect(denyReason(OWNER)).toBe('not_owner');
  });
});

describe('buildOwnerDeclineMessage', () => {
  it('mentions the owner by Slack id so it renders as a tappable profile link', () => {
    const msg = buildOwnerDeclineMessage(OWNER);
    expect(msg).toContain(`<@${OWNER}>`);
    expect(msg).toMatch(/personal AI assistant/i);
    expect(msg).toMatch(/messaging them directly/i);
  });

  it('uses the owner display name when available, with the mention in parens', () => {
    const profile: OwnerIdentity = { userId: OWNER, displayName: 'Amit' };
    const msg = buildOwnerDeclineMessage(OWNER, profile);
    expect(msg).toContain('Amit');
    expect(msg).toContain(`<@${OWNER}>`);
    // Name precedes the parenthesised mention so it reads naturally.
    expect(msg.indexOf('Amit')).toBeLessThan(msg.indexOf(`<@${OWNER}>`));
  });

  it('falls back to realName when displayName is missing', () => {
    const profile: OwnerIdentity = { userId: OWNER, realName: 'Amit Ray' };
    expect(buildOwnerDeclineMessage(OWNER, profile)).toContain('Amit Ray');
  });

  it('still mentions the owner when no profile has resolved yet (boot race safe)', () => {
    // ownerSlackUserId is known from env at boot; only the friendly-name
    // preface depends on the async users.info lookup. The mention always
    // fires so the requester gets a working next step.
    const msg = buildOwnerDeclineMessage(OWNER, undefined);
    expect(msg).toContain(`<@${OWNER}>`);
  });

  it('uses a generic message when no owner is configured at all', () => {
    const msg = buildOwnerDeclineMessage(null);
    expect(msg).not.toContain('<@');
    expect(msg).toMatch(/not currently accepting requests/i);
  });
});
