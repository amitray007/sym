import { z } from "zod";
import { Brief } from "../jobs/brief.ts";
import { isValidCron } from "./cron.ts";

// The schedule_create tool input.
export const ScheduleInput = z.object({
  cron: z
    .string()
    .refine(isValidCron, "Use 5 fields: minute hour day-of-month month day-of-week.")
    .describe("Five-field cron in UTC, for example '0 9 * * 1-5' for 09:00 UTC on weekdays."),
  title: z.string().min(3).max(80).describe("Short name, for example 'On-call check'."),
  brief: Brief.describe(
    "The job brief each run starts. Keep production and customer data read-only.",
  ),
  channel: z
    .string()
    .optional()
    .describe("Slack channel ID for the run threads. Default: the channel of this conversation."),
});

// The worker_job tool input: a brief, plus the schedule reference when a scheduled run passes the
// stored brief (decision 024).
export const ScheduledBrief = Brief.extend({
  schedule: z
    .string()
    .optional()
    .describe("Schedule reference such as S-3. Only for a scheduled run; leave the brief as is."),
});
