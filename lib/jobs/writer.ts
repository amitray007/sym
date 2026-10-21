import { z } from "zod";
import { envSwitch } from "../env-switch.ts";
import type { OutputContract } from "./contract.ts";

// The written result (decision 062). When a code job ends in a live session, the `writer`
// subagent writes the result message in the persona's voice, with no template. Sym's code still
// posts it, adds the buttons and a footer, and keeps the check concerns visible. Without a
// writer reply, the result falls back to the template in blocks.ts. No I/O: this module runs
// inside the workflow bundle.

// Slack's markdown block holds 12,000 characters. The writer gets less, so the post has room.
export const WRITTEN_MAX = 6_000;
// The worker's report is long; the writer reads its start, where the findings are.
const MAX_REPORT = 12_000;

export const WriterOutput = z.object({
  text: z.string().trim().min(1).max(WRITTEN_MAX),
});
export type WriterOutput = z.infer<typeof WriterOutput>;

// On by default; `SYM_RESULT_WRITER=off` keeps the template for every result.
export function writerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return envSwitch(env.SYM_RESULT_WRITER, true);
}

export interface WriterRequest {
  ref: string;
  title: string;
  project: string;
  goal: string;
  duration: string | null;
  // The persona text, or nothing when no persona loads.
  persona: string | null;
  // Approved playbooks and rules, in the form the brain gets them. They hold what the owner
  // taught Sym, such as how results should read.
  learned: string | null;
  contract: OutputContract;
  // The PR the result links, from the worker or its facts.
  prUrl: string | null;
  // Rule and model check concerns. Sym shows them under the written text.
  concerns: string[];
  workerMessage: string | null;
}

// JSON that cannot close the tag around it: every `<` becomes the escape `\u003c`.
function data(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/</g, "\\u003c");
}

// The message for the `writer` subagent. The job facts, the persona, and the learned rows come
// from Sym. The worker's result and report sit in a tag marked as untrusted data.
export function writerMessage(request: WriterRequest): string {
  const report = request.workerMessage ?? "";
  return [
    `Write the message that tells the team how job ${request.ref} ended.`,
    `<voice>\n${request.persona ?? "No persona is set. Write plainly."}\n</voice>`,
    ...(request.learned ? [`<learned>\n${request.learned}\n</learned>`] : []),
    `<job>\n${data({
      ref: request.ref,
      title: request.title,
      project: request.project,
      goal: request.goal,
      duration: request.duration,
      pr_url: request.prUrl,
    })}\n</job>`,
    `<check_concerns>\n${data(request.concerns)}\n</check_concerns>`,
    `<worker_result untrusted="true">\n${data({
      summary: request.contract.summary,
      tests: request.contract.tests,
      files_changed: request.contract.filesChanged,
      open_questions: request.contract.openQuestions,
      report: report.length > MAX_REPORT ? `${report.slice(0, MAX_REPORT)}…` : report,
    })}\n</worker_result>`,
  ].join("\n\n");
}
