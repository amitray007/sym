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

export function threadLine(job: JobFacts): string | null {
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

export function duration(job: JobFacts): string | undefined {
  return job.durationMs === undefined ? undefined : formatDuration(job.durationMs);
}

/** The facts of a result message, before any Slack formatting. Values are raw worker text. */
export interface ResultView {
  emoji: string;
  /** The model verdict line that stands alone under the gist. */
  verdict: string | null;
  gist: string;
  /** The header of the concerns list, which carries the verdict when there is one. */
  concernsHeader: string | null;
  concerns: string[];
  questions: string[];
  pr: { url: string; label: string } | null;
  tests: string;
  filesChanged: number;
  duration: string | undefined;
  /** The worker returned no result block, so there is no summary to show. */
  noResult: boolean;
}

// `concerns` come from the result checks (lib/jobs/verify.ts): the rule checks, then the model
// check. `verdict` is the model check's note, when the job tried one: a clean one-line verdict,
// or the header of the concerns list with its confidence.
export function resultView(
  job: JobFacts,
  contract: OutputContract | null,
  concerns: string[] = [],
  verdict: string | null = null,
): ResultView {
  if (!contract) {
    return {
      emoji: "⚠️",
      verdict,
      gist: `the ${workerNoun()} sent no result summary. open the ${workerNoun()} thread to read the result.`,
      concernsHeader: null,
      concerns: [],
      questions: [],
      pr: null,
      tests: "",
      filesChanged: 0,
      duration: duration(job),
      noResult: true,
    };
  }
  const flagged = concerns.length > 0;
  // A concern that already says what an open question says makes the question redundant.
  const questions = contract.openQuestions.filter(
    (question) => !concerns.some((concern) => nearDuplicate(concern, question)),
  );
  // The verdict heads the concerns list when there is one, else it stands alone under the gist.
  const headsList = flagged && verdict?.startsWith(CONCERNS_HEADER) === true;
  return {
    emoji: flagged ? "⚠️" : "✅",
    verdict: headsList ? null : verdict,
    gist: tldr(contract.summary),
    concernsHeader: flagged ? (headsList && verdict ? verdict : CONCERNS_HEADER) : null,
    concerns,
    questions,
    pr: contract.prUrl
      ? { url: contract.prUrl, label: prLabel(contract.prUrl) ?? "pull request" }
      : null,
    tests: contract.tests ? testsNote(contract.tests) : "",
    filesChanged: contract.filesChanged.length,
    duration: duration(job),
    noResult: false,
  };
}

export function resultMessage(
  job: JobFacts,
  contract: OutputContract | null,
  concerns: string[] = [],
  verdict: string | null = null,
): string {
  const view = resultView(job, contract, concerns, verdict);
  if (view.noResult) {
    return sections([
      lines([headline("⚠️", job, view.duration), `*tl;dr* ${view.gist}`, view.verdict]),
      threadLine(job),
    ]);
  }

  const count = view.filesChanged;
  const facts = [
    view.pr && `🔗 ${link(view.pr.url, view.pr.label)}`,
    view.tests && `tests: ${escapeMrkdwn(view.tests)}`,
    count > 0 && `${count} ${count === 1 ? "file" : "files"} changed`,
  ].filter((part): part is string => typeof part === "string" && part !== "");

  return sections([
    lines([
      headline(view.emoji, job, view.duration),
      view.gist && `*tl;dr* ${escapeMrkdwn(view.gist)}`,
      view.verdict,
    ]),
    view.concernsHeader !== null &&
      lines([
        view.concernsHeader,
        ...view.concerns.map((concern, index) => `${index + 1}. ${escapeMrkdwn(concern)}`),
      ]),
    view.questions.length > 0 &&
      lines([
        "*open questions*",
        ...view.questions.map((question) => `☐ ${escapeMrkdwn(question)}`),
      ]),
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
