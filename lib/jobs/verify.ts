import { z } from "zod";
import { envSwitch } from "../env-switch.ts";
import type { OutputContract } from "./contract.ts";
import { nearDuplicate } from "./similar.ts";

// Deterministic result checks (docs/architecture.md, flow 4), run before any model review. They
// compare what the worker says it did with what the job allowed. No I/O: this module runs inside
// the workflow bundle, so it matches globs itself instead of importing node:path.

export interface ResultRules {
  // Glob patterns the worker may change, such as `src/**`. Absent means any path.
  allowedPaths?: string[];
  // Whether the job allowed a pull request at all.
  pullRequestAllowed: boolean;
}

export interface Verdict {
  verdict: "pass" | "concerns";
  concerns: string[];
}

export function checkResult(contract: OutputContract | null, rules: ResultRules): Verdict {
  if (!contract) {
    return { verdict: "concerns", concerns: ["worker did not return its result block."] };
  }
  const concerns: string[] = [];
  if (rules.allowedPaths && rules.allowedPaths.length > 0) {
    const outside = contract.filesChanged.filter((file) => {
      const path = repoPath(file);
      return (
        path === undefined || !rules.allowedPaths?.some((pattern) => matchesGlob(path, pattern))
      );
    });
    if (outside.length > 0) {
      concerns.push(`changed files outside the allowed paths: ${outside.join(", ")}.`);
    }
  }
  if (contract.prUrl && !rules.pullRequestAllowed) {
    concerns.push("worker opened a PR the job didn't allow.");
  }
  if (contract.openQuestions.length > 0) {
    concerns.push(`worker left ${contract.openQuestions.length} open question(s).`);
  }
  return { verdict: concerns.length > 0 ? "concerns" : "pass", concerns };
}

// A worker's path as a clean repository-relative path, or nothing when it is absolute or climbs
// out of the repository. `src/../../x` must not pass as `src/**`.
export function repoPath(file: string): string | undefined {
  const raw = file.trim().replace(/\\/g, "/");
  if (raw === "" || raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw)) return undefined;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : undefined;
}

// `**` matches across folders, `*` within one folder, `?` one character. A leading `./` or `/` on
// the path is ignored, so worker paths and pack patterns compare the same way.
export function matchesGlob(path: string, pattern: string): boolean {
  const clean = path.replace(/^\.?\//, "");
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? "";
    if (char === "*" && pattern[i + 1] === "*") {
      // `**/` also matches no folder at all, so `src/**/a.ts` matches `src/a.ts`.
      if (pattern[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`).test(clean);
}

// The model check is opt-in (decision 054): without `SYM_VERIFIER=on`, a finished code job ends
// with the rule checks alone and its result has no verifier line.
export function verifierEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return envSwitch(env.SYM_VERIFIER, false);
}

// The model check (docs/architecture.md, flow 4, decision 032). The `verifier` subagent returns
// this shape. worker_job passes it as the turn's outputSchema, and finishJob parses it again, so a
// malformed reply counts as an unavailable check instead of a broken result.
export const VerifierOutput = z.object({
  verdict: z.enum(["pass", "concerns"]),
  concerns: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type VerifierOutput = z.infer<typeof VerifierOutput>;

// What the model check gave the job: a verdict, or nothing because it failed or timed out.
// Jobs that skip the model check (reconcile, scheduled checks, a cancel) pass no ModelCheck.
export type ModelCheck =
  | { status: "checked"; output: VerifierOutput }
  | { status: "unavailable"; reason: string };

// A model concern can repeat worker text, so the list and each line stay short.
const MAX_MODEL_CONCERNS = 8;
const MAX_CONCERN_LENGTH = 300;

// The deterministic concerns first, then the model's, without repeats. Two concerns repeat when
// they match after case, spacing, and a final period are ignored, or when they say nearly the
// same thing (lib/jobs/similar.ts).
export function mergeConcerns(deterministic: string[], model: string[] = []): string[] {
  const key = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim().replace(/\.$/, "");
  const seen = new Set<string>();
  const merged: string[] = [];
  const add = (text: string) => {
    const k = key(text);
    if (k === "" || seen.has(k)) return;
    if (merged.some((kept) => nearDuplicate(kept, text))) return;
    seen.add(k);
    merged.push(text.trim());
  };
  for (const concern of deterministic) add(concern);
  for (const concern of model.slice(0, MAX_MODEL_CONCERNS)) {
    const flat = concern.replace(/\s+/g, " ").trim();
    add(flat.length > MAX_CONCERN_LENGTH ? `${flat.slice(0, MAX_CONCERN_LENGTH - 1)}…` : flat);
  }
  return merged;
}

// The model check's concerns, or none when it gave no verdict.
export function modelConcerns(check: ModelCheck | undefined): string[] {
  return check?.status === "checked" ? check.output.concerns : [];
}

// The header of the concerns list in the result message. The model check's confidence joins it.
export const CONCERNS_HEADER = "*⚠️ check before merge*";

// The model check's note in the result message. Only a job that tried the model check gets one.
// A clean verdict is one line. With concerns, the verdict is the header of the concerns list.
export function verdictLine(check: ModelCheck | undefined, concerns: string[]): string | null {
  if (!check) return null;
  if (check.status === "unavailable") {
    return "verifier unavailable, only the rule checks ran";
  }
  const confidence = `${Math.round(check.output.confidence * 100)}% sure`;
  const pass = check.output.verdict === "pass" && concerns.length === 0;
  return pass
    ? `✅ verifier: matches the brief (${confidence})`
    : `${CONCERNS_HEADER} (${confidence})`;
}

export interface VerifierRequest {
  goal: string;
  doneWhen: string[];
  constraints: string[];
  contract: OutputContract;
  // The deterministic concerns, from checkResult and resultConcerns.
  concerns: string[];
  // The worker's final message. Untrusted.
  workerMessage: string | null;
}

const MAX_WORKER_MESSAGE = 6_000;

// JSON that cannot close the tag around it: `<` becomes <.
function data(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/</g, "\\u003c");
}

// The message for the `verifier` subagent. The brief and the rule checks come from Sym. The
// result block and the final message come from the worker, so they sit in a tag marked as
// untrusted data.
export function verifierMessage(request: VerifierRequest): string {
  const message = request.workerMessage ?? "";
  return [
    "Check this worker result against its brief. Reply with your verdict.",
    `<brief>\n${data({ goal: request.goal, done_when: request.doneWhen, constraints: request.constraints })}\n</brief>`,
    `<rule_check_concerns>\n${data(request.concerns)}\n</rule_check_concerns>`,
    `<worker_result untrusted="true">\n${data({
      summary: request.contract.summary,
      pr_url: request.contract.prUrl,
      tests: request.contract.tests,
      files_changed: request.contract.filesChanged,
      open_questions: request.contract.openQuestions,
      final_message:
        message.length > MAX_WORKER_MESSAGE ? `${message.slice(0, MAX_WORKER_MESSAGE)}…` : message,
    })}\n</worker_result>`,
  ].join("\n\n");
}

// Reads the rule-check concerns back out of a verifier message. The fixture verifier uses it.
export function ruleConcernsIn(message: string): string[] {
  const block = /<rule_check_concerns>\s*([\s\S]*?)\s*<\/rule_check_concerns>/.exec(message)?.[1];
  if (!block) return [];
  try {
    const value: unknown = JSON.parse(block);
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}
