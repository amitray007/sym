import { z } from "zod";

// The output contract: the JSON block that ends the worker's last message (see workerMessage in
// brief.ts). Only the summary is required, so a half-filled block still gives Sym something.
const Raw = z.object({
  summary: z.string().min(1),
  pr_url: z.string().nullish(),
  tests: z.string().default(""),
  files_changed: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
});

export interface OutputContract {
  summary: string;
  prUrl: string | null;
  tests: string;
  filesChanged: string[];
  openQuestions: string[];
}

const FENCE = /```json[^\S\n]*\n([\s\S]*?)```/gi;

// Reads the last json block. An earlier block can be an example, so it never stands in for a
// broken last one.
export function parseOutputContract(message: string | null): OutputContract | null {
  if (!message) return null;
  const blocks = [...message.matchAll(FENCE)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) return null;

  let value: unknown;
  try {
    value = JSON.parse(last);
  } catch {
    return null;
  }
  const parsed = Raw.safeParse(value);
  if (!parsed.success) return null;
  const raw = parsed.data;
  return {
    summary: raw.summary,
    prUrl: raw.pr_url ? raw.pr_url : null,
    tests: raw.tests,
    filesChanged: raw.files_changed,
    openQuestions: raw.open_questions,
  };
}
