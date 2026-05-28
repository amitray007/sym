import type { SlackUserId } from '@sym/contracts';
import type { OwnerIdentity } from '@sym/kernel';

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
 * Build the one-line decline a non-owner sees when they DM Sym. Channels stay
 * silent (Sym is invisible to the rest of the team there); a DM is a 1:1, so
 * total silence just looks broken — and unhelpful.
 *
 * We name the owner with a Slack mention (`<@U…>`) so it renders as a tappable
 * profile link in Slack — the requester gets a clear next step (message the
 * owner directly) instead of a dead end. Falling back to a generic line when
 * we haven't resolved the owner's profile yet keeps the boot race safe.
 *
 * The owner profile may not be set yet (boot-time `users.info` hasn't returned
 * before the first denial) or may have failed to resolve. In both cases we
 * still know `ownerSlackUserId`, so we always mention; the friendly-name
 * preface ("…assistant for Amit") is only added when we have one.
 */
export function buildOwnerDeclineMessage(
  ownerSlackUserId: SlackUserId | null,
  ownerProfile?: OwnerIdentity,
): string {
  // No configured owner at all — generic line; nobody to point them to.
  if (ownerSlackUserId === null) {
    return "👋 I'm Sym — a personal AI assistant. I'm not currently accepting requests.";
  }

  const mention = `<@${ownerSlackUserId}>`;
  const friendlyName = ownerProfile?.displayName ?? ownerProfile?.realName;
  const ownerPhrase = friendlyName
    ? `${friendlyName}'s personal AI assistant (${mention})`
    : `${mention}'s personal AI assistant`;

  return `👋 I'm Sym — ${ownerPhrase}. I only take requests from them. Try messaging them directly!`;
}
