import type { Brand } from './brand.js';

/**
 * Branded identifiers. External ids keep their source-of-truth shape (Slack ids
 * like `U0123`/`C0123`, Slack timestamps as strings).
 */

// --- Internal row ids ---
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type ConversationId = Brand<string, 'ConversationId'>;

// --- External ids (source-of-truth shape) ---
export type SlackUserId = Brand<string, 'SlackUserId'>;
export type SlackChannelId = Brand<string, 'SlackChannelId'>;
/** Slack timestamps are strings, e.g. `1700000000.000100`; also thread keys. */
export type SlackThreadTs = Brand<string, 'SlackThreadTs'>;
export type SlackEventId = Brand<string, 'SlackEventId'>;

// --- Kernel-generated runtime ids ---
export type TurnId = Brand<string, 'TurnId'>;
