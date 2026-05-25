ALTER TABLE "workspaces" ADD COLUMN "owner_slack_user_id" text;--> statement-breakpoint
-- Backfill: the owner of an existing single-tenant install is whoever performed
-- the active Slack install (slack_installs.installed_by_slack_user_id). Idempotent
-- — only fills NULLs — so re-running the migration is safe.
UPDATE "workspaces" AS w
SET "owner_slack_user_id" = si."installed_by_slack_user_id"
FROM "slack_installs" AS si
WHERE si."workspace_id" = w."id"
  AND si."status" = 'active'
  AND w."owner_slack_user_id" IS NULL;