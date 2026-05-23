CREATE TYPE "public"."slack_install_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."workspace_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."admin_role" AS ENUM('owner', 'admin');--> statement-breakpoint
CREATE TYPE "public"."acl_mode" AS ENUM('open', 'allowlist', 'workspace_minus_blocked');--> statement-breakpoint
CREATE TYPE "public"."acl_surface" AS ENUM('slack', 'dashboard');--> statement-breakpoint
CREATE TYPE "public"."acl_user_status" AS ENUM('allow', 'block');--> statement-breakpoint
CREATE TYPE "public"."mcp_transport" AS ENUM('http', 'stdio');--> statement-breakpoint
CREATE TYPE "public"."soul_layer" AS ENUM('l1_workspace', 'l2_channel', 'l3_user');--> statement-breakpoint
CREATE TYPE "public"."memory_scope" AS ENUM('workspace', 'channel', 'thread', 'dm', 'custom_relational');--> statement-breakpoint
CREATE TYPE "public"."memory_status" AS ENUM('active', 'superseded', 'forgotten');--> statement-breakpoint
CREATE TYPE "public"."subject_consent_status" AS ENUM('pending', 'accepted', 'rejected', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."oauth_token_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."conversation_entry_surface" AS ENUM('app_mention', 'dm', 'shortcut', 'slash_command', 'task');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system', 'tool');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'running', 'completed', 'failed', 'dead_letter');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_kind" AS ENUM('slack_user', 'admin', 'system', 'sandbox');--> statement-breakpoint
CREATE TABLE "slack_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"app_id" text NOT NULL,
	"bot_access_token" text NOT NULL,
	"scopes" text[] NOT NULL,
	"enterprise_id" text,
	"installed_by_slack_user_id" text NOT NULL,
	"installed_by_admin_id" text,
	"raw_install_payload" text,
	"status" "slack_install_status" DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"slack_team_id" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text,
	"status" "workspace_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slack_team_id_unique" UNIQUE("slack_team_id")
);
--> statement-breakpoint
CREATE TABLE "dashboard_admins" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"clerk_user_id" text NOT NULL,
	"email" text NOT NULL,
	"role" "admin_role" DEFAULT 'admin' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_admin_id" text,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "acl_modes" (
	"workspace_id" text NOT NULL,
	"surface" "acl_surface" NOT NULL,
	"mode" "acl_mode" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" text,
	CONSTRAINT "acl_modes_workspace_id_surface_pk" PRIMARY KEY("workspace_id","surface")
);
--> statement-breakpoint
CREATE TABLE "acl_user_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"surface" "acl_surface" NOT NULL,
	"slack_user_id" text NOT NULL,
	"status" "acl_user_status" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" text
);
--> statement-breakpoint
CREATE TABLE "mcp_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"transport" "mcp_transport" NOT NULL,
	"url" text,
	"command" text,
	"args" text[] DEFAULT '{}'::text[] NOT NULL,
	"env_json" text,
	"oauth_config_json" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" text,
	CONSTRAINT "mcp_configs_transport_target" CHECK (("mcp_configs"."transport" = 'http' AND "mcp_configs"."url" IS NOT NULL) OR ("mcp_configs"."transport" = 'stdio' AND "mcp_configs"."command" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "provider_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"api_key" text NOT NULL,
	"base_url" text,
	"model_chat" text NOT NULL,
	"model_tone_rewrite" text NOT NULL,
	"model_summarization" text NOT NULL,
	"extra_models_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" text
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"frontmatter_json" jsonb NOT NULL,
	"body_md" text NOT NULL,
	"activation_pattern" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" text
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"value_json" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" text,
	CONSTRAINT "workspace_settings_workspace_id_key_pk" PRIMARY KEY("workspace_id","key")
);
--> statement-breakpoint
CREATE TABLE "soul_layers" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"layer" "soul_layer" NOT NULL,
	"scope_id" text,
	"content_md" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" text,
	CONSTRAINT "soul_layers_scope_shape" CHECK (("soul_layers"."layer" = 'l1_workspace' AND "soul_layers"."scope_id" IS NULL) OR ("soul_layers"."layer" IN ('l2_channel','l3_user') AND "soul_layers"."scope_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"scope" "memory_scope" NOT NULL,
	"scope_key" text,
	"actor_id" text NOT NULL,
	"subject_id" text,
	"content" text NOT NULL,
	"status" "memory_status" DEFAULT 'active' NOT NULL,
	"supersedes_id" text,
	"subject_consent_status" "subject_consent_status" DEFAULT 'not_applicable' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_referenced_at" timestamp with time zone,
	"audit_event_id" bigint,
	CONSTRAINT "memory_entries_workspace_scope_key" CHECK ("memory_entries"."scope" != 'workspace' OR "memory_entries"."scope_key" IS NULL),
	CONSTRAINT "memory_entries_channel_thread_dm_shape" CHECK ("memory_entries"."scope" NOT IN ('channel','thread','dm') OR ("memory_entries"."scope_key" IS NOT NULL AND "memory_entries"."subject_id" IS NULL)),
	CONSTRAINT "memory_entries_custom_relational_shape" CHECK ("memory_entries"."scope" != 'custom_relational' OR ("memory_entries"."subject_id" IS NOT NULL AND "memory_entries"."subject_consent_status" != 'not_applicable'))
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"grantor_slack_user_id" text NOT NULL,
	"grantee_slack_user_id" text NOT NULL,
	"provider" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_slack_user_id" text
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"provider" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"account_handle" text,
	"status" "oauth_token_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"entry_surface" "conversation_entry_surface" NOT NULL,
	"slack_channel_id" text,
	"slack_thread_ts" text,
	"initiator_slack_user_id" text NOT NULL,
	"status" "conversation_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_turn_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"role" "message_role" NOT NULL,
	"author_slack_user_id" text,
	"content_json" jsonb NOT NULL,
	"slack_ts" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"audit_event_id" bigint
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"slice_id" text NOT NULL,
	"version" integer NOT NULL,
	"state_blob" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"due_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"actor_kind" "audit_actor_kind" NOT NULL,
	"actor_id" text NOT NULL,
	"on_behalf_of" text,
	"target_kind" text,
	"target_id" text,
	"payload_json" jsonb NOT NULL,
	"prev_hash" "bytea",
	"this_hash" "bytea" NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_payload_size" CHECK (octet_length("audit_events"."payload_json"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"sandbox_jwt_id" text NOT NULL,
	"requester_slack_user_id" text NOT NULL,
	"provider" text NOT NULL,
	"domain" text NOT NULL,
	"oauth_token_id" text NOT NULL,
	"on_behalf_of_slack_user_id" text,
	"grant_id" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "leases_sandbox_jwt_id_unique" UNIQUE("sandbox_jwt_id")
);
--> statement-breakpoint
ALTER TABLE "slack_installs" ADD CONSTRAINT "slack_installs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_installs" ADD CONSTRAINT "slack_installs_installed_by_admin_id_dashboard_admins_id_fk" FOREIGN KEY ("installed_by_admin_id") REFERENCES "public"."dashboard_admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_admins" ADD CONSTRAINT "dashboard_admins_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_admins" ADD CONSTRAINT "dashboard_admins_created_by_admin_id_dashboard_admins_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."dashboard_admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acl_modes" ADD CONSTRAINT "acl_modes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acl_modes" ADD CONSTRAINT "acl_modes_updated_by_admin_id_dashboard_admins_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."dashboard_admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acl_user_rules" ADD CONSTRAINT "acl_user_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acl_user_rules" ADD CONSTRAINT "acl_user_rules_updated_by_admin_id_dashboard_admins_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."dashboard_admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_configs" ADD CONSTRAINT "mcp_configs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_configs" ADD CONSTRAINT "mcp_configs_updated_by_admin_id_dashboard_admins_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."dashboard_admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_updated_by_admin_id_dashboard_admins_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."dashboard_admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_updated_by_admin_id_dashboard_admins_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."dashboard_admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_updated_by_admin_id_dashboard_admins_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."dashboard_admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soul_layers" ADD CONSTRAINT "soul_layers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soul_layers" ADD CONSTRAINT "soul_layers_updated_by_admin_id_dashboard_admins_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."dashboard_admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_supersedes_id_memory_entries_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."memory_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_audit_event_id_audit_events_id_fk" FOREIGN KEY ("audit_event_id") REFERENCES "public"."audit_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_audit_event_id_audit_events_id_fk" FOREIGN KEY ("audit_event_id") REFERENCES "public"."audit_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD CONSTRAINT "checkpoints_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_oauth_token_id_oauth_tokens_id_fk" FOREIGN KEY ("oauth_token_id") REFERENCES "public"."oauth_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_installs_one_active_per_ws" ON "slack_installs" USING btree ("workspace_id") WHERE "slack_installs"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_admins_ws_clerk_user" ON "dashboard_admins" USING btree ("workspace_id","clerk_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_admins_one_owner_per_ws" ON "dashboard_admins" USING btree ("workspace_id") WHERE "dashboard_admins"."role" = 'owner';--> statement-breakpoint
CREATE UNIQUE INDEX "acl_user_rules_ws_surface_user" ON "acl_user_rules" USING btree ("workspace_id","surface","slack_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_configs_ws_slug" ON "mcp_configs" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_configs_one_active_per_provider" ON "provider_configs" USING btree ("workspace_id","provider") WHERE "provider_configs"."enabled" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_ws_slug" ON "skills" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "soul_layers_ws_layer_scope" ON "soul_layers" USING btree ("workspace_id","layer","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "soul_layers_one_l1_per_ws" ON "soul_layers" USING btree ("workspace_id") WHERE "soul_layers"."layer" = 'l1_workspace';--> statement-breakpoint
CREATE INDEX "memory_entries_retrieval" ON "memory_entries" USING btree ("workspace_id","scope","scope_key","status");--> statement-breakpoint
CREATE INDEX "memory_entries_subject" ON "memory_entries" USING btree ("workspace_id","subject_id","status") WHERE "memory_entries"."subject_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "grants_lookup" ON "grants" USING btree ("workspace_id","grantee_slack_user_id","provider","expires_at") WHERE "grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_tokens_one_active_per_user_provider" ON "oauth_tokens" USING btree ("workspace_id","slack_user_id","provider") WHERE "oauth_tokens"."status" = 'active';--> statement-breakpoint
CREATE INDEX "conversations_channel_thread" ON "conversations" USING btree ("workspace_id","slack_channel_id","slack_thread_ts");--> statement-breakpoint
CREATE INDEX "messages_conversation_created" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "checkpoints_conversation_slice" ON "checkpoints" USING btree ("conversation_id","slice_id");--> statement-breakpoint
CREATE INDEX "checkpoints_unconsumed_expiry" ON "checkpoints" USING btree ("expires_at") WHERE "checkpoints"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tasks_pending_due" ON "tasks" USING btree ("status","due_at") WHERE "tasks"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "audit_events_ws_ts" ON "audit_events" USING btree ("workspace_id","ts");--> statement-breakpoint
CREATE INDEX "audit_events_ws_kind_ts" ON "audit_events" USING btree ("workspace_id","kind","ts");--> statement-breakpoint
CREATE INDEX "leases_expiry" ON "leases" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "leases_proxy_lookup" ON "leases" USING btree ("workspace_id","requester_slack_user_id","provider","domain") WHERE "leases"."consumed_at" IS NULL;