import { workerLabel, workerNoun } from "../worker-label.ts";
import type { Brief } from "./brief.ts";
import { formatDuration, prLabel } from "./card.ts";
import type { OutputContract } from "./contract.ts";
import { nearDuplicate } from "./similar.ts";
import { CONCERNS_HEADER } from "./verify.ts";

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
  return job.workerThreadId
    ? `${workerLabel()} thread: \`${escapeMrkdwn(job.workerThreadId)}\``
    : null;
}

function lines(parts: (string | null | false | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join("\n");
}

// Sections sit apart by one blank line, so the message scans at a glance.
function sections(parts: (string | null | false | undefined)[]): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join("\n\n");
}

const TLDR_MAX = 160;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * The one-line gist of a worker summary: the whole summary when it is short, else its first
 * sentence, capped. The full text stays in the ledger and in the worker thread.
 */
export function tldr(summary: string, max = TLDR_MAX): string {
  const flat = summary.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const first = /^.+?[.!?](?=\s)/.exec(flat)?.[0] ?? flat;
  return clip(first, max);
}

// The first clause of the tests line, so a long note does not bury the footer.
function testsNote(tests: string): string {
  return clip(tests.replace(/\s+/g, " ").trim().split(/;\s/)[0] ?? "", 80);
}

function headline(emoji: string, job: JobFacts, tail?: string): string {
  return `${emoji} *${escapeMrkdwn(job.ref)} · ${escapeMrkdwn(job.title)}*${tail ? ` · ${tail}` : ""}`;
}

function duration(job: JobFacts): string | undefined {
  return job.durationMs === undefined ? undefined : formatDuration(job.durationMs);
}

// `concerns` come from the result checks (lib/jobs/verify.ts): the rule checks, then the model
// check. `verdict` is the model check's note, when the job tried one: a clean one-line verdict,
// or the header of the concerns list with its confidence.
export function resultMessage(
  job: JobFacts,
  contract: OutputContract | null,
  concerns: string[] = [],
  verdict: string | null = null,
): string {
  if (!contract) {
    return sections([
      lines([
        headline("⚠️", job, duration(job)),
        `*tl;dr* the ${workerNoun()} sent no result summary. open the ${workerNoun()} thread to read the result.`,
        verdict,
      ]),
      threadLine(job),
    ]);
  }

  const flagged = concerns.length > 0;
  // A concern that already says what an open question says makes the question redundant.
  const questions = contract.openQuestions.filter(
    (question) => !concerns.some((concern) => nearDuplicate(concern, question)),
  );
  const pr = contract.prUrl ? (prLabel(contract.prUrl) ?? "pull request") : null;
  const count = contract.filesChanged.length;
  const tests = contract.tests ? testsNote(contract.tests) : "";
  const facts = [
    contract.prUrl && pr ? `🔗 ${link(contract.prUrl, pr)}` : null,
    tests && `tests: ${escapeMrkdwn(tests)}`,
    count > 0 && `${count} ${count === 1 ? "file" : "files"} changed`,
  ].filter((part): part is string => typeof part === "string" && part !== "");

  // The verdict heads the concerns list when there is one, else it stands alone under the gist.
  const headsList = flagged && verdict?.startsWith(CONCERNS_HEADER) === true;
  const gist = tldr(contract.summary);
  return sections([
    lines([
      headline(flagged ? "⚠️" : "✅", job, duration(job)),
      gist && `*tl;dr* ${escapeMrkdwn(gist)}`,
      !headsList && verdict,
    ]),
    flagged &&
      lines([
        headsList ? verdict : CONCERNS_HEADER,
        ...concerns.map((concern, index) => `${index + 1}. ${escapeMrkdwn(concern)}`),
      ]),
    questions.length > 0 &&
      lines(["*open questions*", ...questions.map((question) => `☐ ${escapeMrkdwn(question)}`)]),
    facts.length > 0 && facts.join(" · "),
  ]);
}

export function failureMessage(job: JobFacts, reason?: string | null): string {
  const time = duration(job);
  return lines([
    headline("❌", job, time ? `failed in ${time}` : "failed"),
    reason ? escapeMrkdwn(reason) : `the ${workerNoun()} stopped before it finished.`,
    threadLine(job),
  ]);
}

/** The DM to the owner when the worker waits on a permission prompt. */
export function permissionBlockMessage(ref: string): string {
  return `🔒 ${ref} is waiting for a permission prompt on the ${workerNoun()}. Approve it in the ${workerNoun()}.`;
}

export function quietNotice(job: JobFacts, quietForMs: number): string {
  return lines([
    `⏳ ${job.ref} has had no new activity for ${formatDuration(quietForMs)}. still running.`,
    threadLine(job),
  ]);
}

/** The full brief, posted in the job thread above the Start, Edit, and Cancel prompt. */
export function briefPrompt(brief: Brief, ref?: string, modelLine?: string): string {
  const bullets = (items: string[]) => items.map((item) => `• ${escapeMrkdwn(item)}`).join("\n");
  const checks = (items: string[]) => items.map((item) => `☐ ${escapeMrkdwn(item)}`).join("\n");
  const delivery = brief.openPullRequest
    ? "push the branch and open a draft PR"
    : "commit on the worktree branch, no push, no PR";
  return lines([
    `📋 *${ref ? `${ref} · ` : ""}${escapeMrkdwn(brief.title)}*`,
    `*project* ${escapeMrkdwn(brief.project)}`,
    `*goal* ${escapeMrkdwn(brief.goal)}`,
    brief.constraints.length > 0 && `*constraints*\n${bullets(brief.constraints)}`,
    `*done when*\n${checks(brief.doneWhen)}`,
    `*delivery* ${delivery}`,
    modelLine && escapeMrkdwn(modelLine),
    "press *Start* to run it, *Edit* to change it, or *Cancel*.",
  ]);
}
