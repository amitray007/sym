import { z } from "zod";
import { Brief } from "../jobs/brief.ts";
import { isValidCron } from "./cron.ts";
import type { ScheduleTiming } from "./rows.ts";

// The schedule_create tool input (decision 085). `scheduleTiming` checks that exactly one of
// `cron` and `at` is set, so the input schema stays a plain object.
export const ScheduleInput = z.object({
  title: z.string().min(3).max(80).describe("Short name, for example 'Open PR check'."),
  instruction: z
    .string()
    .min(3)
    .max(4000)
    .describe(
      "What to do on each run, in plain words, with the exact facts: projects, channels, " +
        "people, links. Each run reads only this text.",
    ),
  cron: z
    .string()
    .refine(isValidCron, "Use 5 fields: minute hour day-of-month month day-of-week.")
    .optional()
    .describe("For a recurring schedule: five-field cron in UTC, such as '0 9 * * 1-5'."),
  at: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("For a one-time run: an ISO time in UTC, such as '2026-11-04T15:00:00Z'."),
  builder: z
    .enum(["ask", "auto"])
    .default("ask")
    .describe(
      "If a run starts Builder work: 'auto' starts it without a click, 'ask' posts Start / " +
        "Not now. Use the person's answer; default 'ask'.",
    ),
  destination: z
    .string()
    .optional()
    .describe(
      "Where runs post: 'dm' for a DM with the person who set it up, or a channel ID, mention, " +
        "or link. Default: this conversation's channel.",
    ),
});
export type ScheduleInput = z.infer<typeof ScheduleInput>;

// Exactly one of a cron and a one-time run, as the row stores them.
export function scheduleTiming(
  input: Pick<ScheduleInput, "cron" | "at">,
): ScheduleTiming | undefined {
  if (input.cron && !input.at) return { cron: input.cron };
  if (input.at && !input.cron) return { runAt: new Date(input.at) };
  return undefined;
}

// The worker_job tool input: a brief, plus the schedule or trigger reference when a run starts
// Builder work (decisions 085 and 088).
export const ScheduledBrief = Brief.extend({
  schedule: z
    .string()
    .optional()
    .describe("Schedule reference such as S-3. Only for a scheduled run: the reference it names."),
  trigger: z
    .string()
    .optional()
    .describe("Trigger reference such as T-3. Only for a trigger run: the reference it names."),
});
