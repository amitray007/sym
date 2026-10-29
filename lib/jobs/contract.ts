import { z } from "zod";

// The output contract: the JSON block that ends the worker's last message (see workerMessage in
// brief.ts). Only the summary is required, so a half-filled block still gives Sym something.
const Raw = z.object({
  summary: z.string().min(1),
  pr_url: z.string().nullish(),
  tests: z.string().default(""),
  tests_status: z.enum(["passed", "failed", "not_run", "unknown", "none"]).optional(),
  ci_status: z.enum(["passed", "failed", "running", "unknown"]).optional(),
  ci_url: z.string().optional(),
  files_changed: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
});

export interface OutputContract {
  summary: string;
  prUrl: string | null;
  tests: string;
  testsStatus?: "passed" | "failed" | "not_run" | "unknown" | "none";
  ciStatus?: "passed" | "failed" | "running" | "unknown";
  ciUrl?: string;
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
    testsStatus: raw.tests_status ?? testStatus(raw.tests),
    ...(raw.ci_status ? { ciStatus: raw.ci_status } : {}),
    ...(raw.ci_url && safeHttpUrl(raw.ci_url) ? { ciUrl: raw.ci_url } : {}),
    filesChanged: raw.files_changed,
    openQuestions: raw.open_questions,
  };
}

// Legacy reports remain readable. Counts of new tests do not establish that tests ran.
export function testStatus(tests: string): NonNullable<OutputContract["testsStatus"]> {
  const skipped = /\b(not run|didn['’]t run|not executed|skipped)\b/i.test(tests);
  const passed = /\b(passed|passing|pass)\b/i.test(tests);
  if (/\b(failed|failing|fail)\b/i.test(tests)) return "failed";
  if (skipped && passed) return "unknown";
  if (skipped) return "not_run";
  if (passed) return "passed";
  if (/^none[.!]?$/i.test(tests.trim())) return "none";
  return "unknown";
}

export function safeHttpUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return ["https:", "http:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      !/[<>|\s]/.test(url)
      ? url
      : null;
  } catch {
    return null;
  }
}

// Explicit failure and skipped reports take precedence over optimistic machine status.
export function reportedTestStatus(
  contract: OutputContract,
): NonNullable<OutputContract["testsStatus"]> {
  const inferred = testStatus(contract.tests);
  const mixed =
    inferred === "unknown" &&
    /\bpass(?:ed|ing)?\b/i.test(contract.tests) &&
    /not run|skipped|didn['’]t run/i.test(contract.tests);
  return mixed
    ? "unknown"
    : inferred === "failed" || inferred === "not_run"
      ? inferred
      : (contract.testsStatus ?? inferred);
}

// Check writer prose before expanding code-owned test tokens.
export function contradictsTestReport(text: string, contract: OutputContract): boolean {
  const actual = reportedTestStatus(contract);
  const subject = String.raw`(?:all\s+)?tests?(?:\s+suite)?\s+(?:(?:is|are|have|has)\s+)?`;
  const claims: [RegExp, NonNullable<OutputContract["testsStatus"]>][] = [
    [
      new RegExp(
        String.raw`\b${subject}(?:pass(?:ed|ing)?|green)\b|\b\d+\s+(?:tests?\s+)?passed\b`,
        "i",
      ),
      "passed",
    ],
    [new RegExp(String.raw`\b${subject}(?:fail(?:ed|ing)?|red)\b`, "i"), "failed"],
    [
      /\btests? (?:did not|didn't|were not|weren't) (?:run|executed)\b|\btests? (?:were )?skipped\b/i,
      "not_run",
    ],
  ];
  return claims.some(([pattern, status]) => pattern.test(text) && actual !== status);
}
