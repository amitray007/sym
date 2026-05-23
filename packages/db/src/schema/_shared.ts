import { timestamp } from 'drizzle-orm/pg-core';

/**
 * Shared column helpers. Every Sym timestamp is `timestamptz` — never naive
 * `timestamp` (db-schema-draft Conventions § Timestamps). `updated_at` is
 * maintained at the application layer via Drizzle hooks, not PG triggers.
 */

export const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const createdAt = () => tstz('created_at').notNull().defaultNow();

export const updatedAt = () => tstz('updated_at').notNull().defaultNow();
