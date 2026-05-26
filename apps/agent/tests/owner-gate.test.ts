import { describe, expect, it } from 'vitest';

import { checkOwnerAccess, denyReason } from '../src/owner-gate.js';

import type { SlackUserId } from '@sym/contracts';

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
