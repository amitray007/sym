import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { encryptedText } from '../columns/encrypted-text.js';
import { uuidv7 } from '../uuid.js';
import { createdAt, updatedAt } from './_shared.js';
import { dashboardAdmins } from './admins.js';
import { workspaces } from './workspaces.js';

export const mcpTransportEnum = pgEnum('mcp_transport', ['http', 'stdio']);

/**
 * Per-workspace tunables. Key-value to avoid migration churn on every new
 * toggle (D-DB-3: dotted keys, e.g. `memory.retention_days.channel`). Values
 * are validated per-key by a Zod schema map in the app layer. Settings that
 * warrant first-class columns get them on `workspaces` instead.
 */
export const workspaceSettings = pgTable(
  'workspace_settings',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    valueJson: jsonb('value_json').notNull(),
    updatedAt: updatedAt(),
    updatedByAdminId: text('updated_by_admin_id').references(() => dashboardAdmins.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

/** LLM provider credentials + model selection per task class. Agent reads on every turn. */
export const providerConfigs = pgTable(
  'provider_configs',
  {
    id: text('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    apiKey: encryptedText('api_key').notNull(),
    baseUrl: text('base_url'),
    modelChat: text('model_chat').notNull(),
    modelToneRewrite: text('model_tone_rewrite').notNull(),
    modelSummarization: text('model_summarization').notNull(),
    extraModelsJson: jsonb('extra_models_json')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    updatedByAdminId: text('updated_by_admin_id').references(() => dashboardAdmins.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    // One active config per provider.
    uniqueIndex('provider_configs_one_active_per_provider')
      .on(t.workspaceId, t.provider)
      .where(sql`${t.enabled} = true`),
  ],
);

/** MCP server connection rows. Edited via Dashboard; no yaml files in v1. */
export const mcpConfigs = pgTable(
  'mcp_configs',
  {
    id: text('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    transport: mcpTransportEnum('transport').notNull(),
    url: text('url'),
    command: text('command'),
    args: text('args')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    envJson: encryptedText('env_json'),
    oauthConfigJson: jsonb('oauth_config_json'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    updatedByAdminId: text('updated_by_admin_id').references(() => dashboardAdmins.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    uniqueIndex('mcp_configs_ws_slug').on(t.workspaceId, t.slug),
    check(
      'mcp_configs_transport_target',
      sql`(${t.transport} = 'http' AND ${t.url} IS NOT NULL) OR (${t.transport} = 'stdio' AND ${t.command} IS NOT NULL)`,
    ),
  ],
);

/**
 * Skill content: markdown body + parsed YAML frontmatter. Edited via Dashboard.
 * Skills NEVER hold secrets — enforced in the skill loader before write.
 */
export const skills = pgTable(
  'skills',
  {
    id: text('id').primaryKey().$defaultFn(uuidv7),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    frontmatterJson: jsonb('frontmatter_json').notNull(),
    bodyMd: text('body_md').notNull(),
    activationPattern: text('activation_pattern'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    updatedByAdminId: text('updated_by_admin_id').references(() => dashboardAdmins.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [uniqueIndex('skills_ws_slug').on(t.workspaceId, t.slug)],
);
