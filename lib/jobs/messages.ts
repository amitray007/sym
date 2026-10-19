import type { Brief } from "./brief.ts";
import { formatDuration, prLabel } from "./card.ts";
import type { OutputContract } from "./contract.ts";

// Text for Sym's own Slack messages. Short, and the result comes first. Worker text is
// untrusted, so every piece of it goes through escapeMrkdwn.

/** Slack asks for exactly these three escapes. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// A link label cannot hold `|`, and a link target cannot hold `>` or whitespace.
function link(url: string, label: string): string {
  const safeUrl = url.replace(/[\s<>|]/g, "");
  return `<${safeUrl}|${escapeMrkdwn(label).replace(/\|/g, "/")}>`;
}

export interface JobFacts {
  ref: string;
  title: string;
  workerThreadId?: string | null;
  /** How long the job ran, in ms. */
  durationMs?: number;
}

function threadLine(job: JobFacts): string | null {
  return job.workerThreadId ? `Worker thread: \`${escapeMrkdwn(job.workerThreadId)}\`` : null;
}

function took(job: JobFacts): string {
  return job.durationMs === undefined ? "" : ` in ${formatDuration(job.durationMs)}`;
}

function lines(parts: (string | null | false | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join("\n");
}

// `concerns` come from the result checks (lib/jobs/verify.ts): the rule checks, then the model
// check. `verdict` is the model check's one line, when the job tried one.
export function resultMessage(
  job: JobFacts,
  contract: OutputContract | null,
  concerns: string[] = [],
  verdict: string | null = null,
): string {
  const head = `*${job.ref} done${took(job)}:* ${escapeMrkdwn(job.title)}`;
  if (!contract) {
    return lines([
      head,
      "The worker sent no result summary. Open the worker thread to read the result.",
      verdict,
      threadLine(job),
    ]);
  }

  const pr = contract.prUrl ? (prLabel(contract.prUrl) ?? "Pull request") : null;
  const count = contract.filesChanged.length;
  return lines([
    head,
    escapeMrkdwn(contract.summary),
    contract.prUrl && pr ? `Draft PR: ${link(contract.prUrl, pr)}` : null,
    contract.tests && `Tests: ${escapeMrkdwn(contract.tests)}`,
    count > 0 && `${count} ${count === 1 ? "file" : "files"} changed`,
    contract.openQuestions.length > 0 &&
      lines([
        "Open questions:",
        ...contract.openQuestions.map((question) => `• ${escapeMrkdwn(question)}`),
      ]),
    verdict,
    concerns.length > 0 &&
      lines(["Check before you merge:", ...concerns.map((c) => `• ${escapeMrkdwn(c)}`)]),
    threadLine(job),
  ]);
}

export function failureMessage(job: JobFacts, reason?: string | null): string {
  return lines([
    `*${job.ref} failed${took(job)}:* ${escapeMrkdwn(job.title)}`,
    reason ? escapeMrkdwn(reason) : "The worker stopped before it finished.",
    threadLine(job),
  ]);
}

/** The DM to the owner when the worker waits on a permission prompt. */
export function permissionBlockMessage(ref: string): string {
  return `${ref} is waiting for a permission prompt on the worker. Approve it in T3.`;
}

export function quietNotice(job: JobFacts, quietForMs: number): string {
  return lines([
    `${job.ref} has had no new activity for ${formatDuration(quietForMs)}. It is still running.`,
    threadLine(job),
  ]);
}

/** The full brief, posted in the job thread above the Start, Edit, and Cancel prompt. */
export function briefPrompt(brief: Brief, ref?: string): string {
  const list = (items: string[]) => items.map((item) => `• ${escapeMrkdwn(item)}`).join("\n");
  const delivery = brief.openPullRequest
    ? "Push the branch and open a draft PR."
    : "Commit on the worktree branch. No push, no PR.";
  return lines([
    `*${ref ? `${ref}: ` : ""}${escapeMrkdwn(brief.title)}*`,
    `Project: ${escapeMrkdwn(brief.project)}`,
    `Goal: ${escapeMrkdwn(brief.goal)}`,
    brief.constraints.length > 0 && `Constraints:\n${list(brief.constraints)}`,
    `Done when:\n${list(brief.doneWhen)}`,
    `Delivery: ${delivery}`,
    "Press Start below to run it, Edit to change it, or Cancel.",
  ]);
}
