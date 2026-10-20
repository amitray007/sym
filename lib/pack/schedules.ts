// The pack's schedules.yaml (docs/adopting.md, decision 055). A list of schedules to seed. The
// brief is the same shape the brain writes, so a seeded row and a chat-made row are alike.
import { z } from "zod";
import { Brief } from "../jobs/brief.ts";
import { findAllowedProject } from "../projects/allowed.ts";
import { isValidCron } from "../schedules/cron.ts";
import type { PackConfig } from "./schema.ts";

export const SCHEDULES_NAME = "schedules.yaml";

// The same pattern as a playbook name (lib/learning/rows.ts).
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const entry = z.strictObject({
  key: z.string().regex(KEY_PATTERN, "must be lowercase words joined by hyphens"),
  title: z.string().min(3).max(80),
  // Five fields, evaluated in UTC.
  cron: z
    .string()
    .refine(isValidCron, "must have 5 fields: minute hour day-of-month month day-of-week"),
  // Defaults to `channels.default` of the manifest.
  channel: z
    .string()
    .regex(/^[CGD][A-Z0-9]+$/, "must be a Slack channel ID")
    .optional(),
  brief: Brief.strict(),
});

export interface PackSchedule {
  key: string;
  title: string;
  cron: string;
  channel: string;
  brief: Brief;
}

export class PackSchedulesError extends Error {
  override name = "PackSchedulesError";
}

// Checks the raw YAML value. Every error names the file, the entry, and the field.
export function parsePackSchedules(raw: unknown, config: PackConfig, file: string): PackSchedule[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new PackSchedulesError(`${file} is invalid: (root): must be a list of schedules`);
  }
  const allowed = config.projects.map((p) => ({
    name: p.name,
    workerProject: p.workerProject ?? p.name,
  }));
  const seen = new Set<string>();
  const out: PackSchedule[] = [];
  raw.forEach((item, index) => {
    const label = (item as { key?: unknown } | null)?.key;
    const where = `${file}, entry ${index + 1}${typeof label === "string" ? ` ("${label}")` : ""}`;
    const parsed = entry.safeParse(item);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(entry)"}: ${issue.message}`)
        .join("; ");
      throw new PackSchedulesError(`${where} is invalid: ${issues}`);
    }
    const value = parsed.data;
    if (seen.has(value.key)) {
      throw new PackSchedulesError(`${where}: key: "${value.key}" is used twice`);
    }
    seen.add(value.key);
    if (!findAllowedProject(allowed, value.brief.project)) {
      throw new PackSchedulesError(
        `${where}: brief.project: "${value.brief.project}" is not in the pack's projects`,
      );
    }
    const channel = value.channel ?? config.channels?.default;
    if (!channel) {
      throw new PackSchedulesError(
        `${where}: channel: set a channel, or set channels.default in sym.config.yaml`,
      );
    }
    out.push({
      key: value.key,
      title: value.title,
      cron: value.cron.trim(),
      channel,
      brief: value.brief,
    });
  });
  return out;
}
