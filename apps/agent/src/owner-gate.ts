import type { SlackUserId } from '@sym/contracts';

/**
 * Single-owner access decision. Sym works for exactly one human (the installer);
 * every other Slack user is denied. We fail CLOSED: if the owner is somehow unset
 * (an install predating the backfill), nobody is allowed — better a silent Sym
 * than one that answers to the whole workspace.
 */
export function checkOwnerAccess(
  requester: SlackUserId,
  ownerSlackUserId: SlackUserId | null,
): 'allow' | 'deny' {
  if (ownerSlackUserId === null) return 'deny';
  return requester === ownerSlackUserId ? 'allow' : 'deny';
}

/** Why a turn was denied — recorded on the `app.turn.denied` audit event. */
export type DenyReason = 'not_owner' | 'owner_unset';

export function denyReason(ownerSlackUserId: SlackUserId | null): DenyReason {
  return ownerSlackUserId === null ? 'owner_unset' : 'not_owner';
}

/**
 * One-line reply when a non-owner DMs Sym. Channels stay silent (Sym is invisible
 * to the rest of the team there); a DM is a 1:1, so total silence just looks
 * broken. Deliberately does not name the owner.
 */
export const OWNER_DECLINE_MESSAGE =
  "👋 I'm a personal assistant — I only take requests from my owner.";
