import type { Brand } from './brand.js';

/**
 * Branded identifiers. Internal Sym rows use UUIDv7 strings; external ids keep
 * their source-of-truth shape (Slack ids like `U0123`/`C0123`, Slack timestamps
 * as strings, Clerk user ids). `audit_events.id` is a bigserial → number.
 *
 * These mirror the `@sym/db` schema. Applying them to Drizzle columns via
 * `.$type<>()` is a later, additive, type-only step (no migration impact).
 */

// --- Internal row ids (UUIDv7 text PKs) ---
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type SlackInstallId = Brand<string, 'SlackInstallId'>;
export type AdminId = Brand<string, 'AdminId'>;
export type AclUserRuleId = Brand<string, 'AclUserRuleId'>;
export type ProviderConfigId = Brand<string, 'ProviderConfigId'>;
export type ConversationId = Brand<string, 'ConversationId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type CheckpointId = Brand<string, 'CheckpointId'>;

// --- Audit (bigserial) ---
export type AuditEventId = Brand<number, 'AuditEventId'>;

// --- External ids (source-of-truth shape) ---
export type SlackTeamId = Brand<string, 'SlackTeamId'>;
export type SlackUserId = Brand<string, 'SlackUserId'>;
export type SlackChannelId = Brand<string, 'SlackChannelId'>;
/** Slack timestamps are strings, e.g. `1700000000.000100`; also thread keys. */
export type SlackThreadTs = Brand<string, 'SlackThreadTs'>;
export type SlackEventId = Brand<string, 'SlackEventId'>;
export type ClerkUserId = Brand<string, 'ClerkUserId'>;

// --- Kernel-generated runtime ids ---
export type TurnId = Brand<string, 'TurnId'>;
export type SliceId = Brand<string, 'SliceId'>;
