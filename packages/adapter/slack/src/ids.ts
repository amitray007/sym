import type { SlackChannelId, SlackUserId } from '@sym/contracts';

/**
 * Returns true when `s` is a Slack user id (`U…` or `W…` for external/shared
 * workspace members).
 */
export function isSlackUserId(s: string): s is SlackUserId {
  return /^[UW][A-Z0-9]+$/.test(s);
}

/**
 * Returns true when `s` is a Slack public/private channel id (`C…`).
 * Does NOT match DM channel ids (`D…`) or MPIM group channel ids (`G…`).
 */
export function isSlackChannelId(s: string): s is SlackChannelId {
  return /^C[A-Z0-9]+$/.test(s);
}

/**
 * Returns true when `s` is a Slack direct-message channel id (`D…`).
 * These are the opaque channel ids Slack assigns to 1:1 DM conversations.
 */
export function isSlackDmId(s: string): boolean {
  return /^D[A-Z0-9]+$/.test(s);
}
