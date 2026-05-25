CREATE TYPE "public"."connector_auth_mode" AS ENUM('none', 'static', 'oauth');--> statement-breakpoint
ALTER TABLE "mcp_configs" ADD COLUMN "auth_mode" "connector_auth_mode" DEFAULT 'none' NOT NULL;