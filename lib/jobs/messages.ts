import { workerLabel, workerNoun } from "../worker-label.ts";
import type { Brief } from "./brief.ts";
import { formatDuration, prLabel } from "./card.ts";
import { type OutputContract, safeHttpUrl, testStatus } from "./contract.ts";

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

export function duration(job: JobFacts): string | undefined {
  return job.durationMs === undefined ? undefined : formatDuration(job.durationMs);
}

export function testSentence(contract: OutputContract): string {
  const inferred = testStatus(contract.tests);
  const status =
    inferred === "failed" || inferred === "not_run" ? inferred : (contract.testsStatus ?? inferred);
  const note = contract.tests.trim();
  const truth = {
    passed: "Tests passed.",
    failed: "Tests failed.",
    not_run: "Tests did not run.",
    unknown: "I don't know whether tests ran.",
    none: "The worker reported that no tests apply.",
  }[status];
  return note ? `${truth} Reported: ${escapeMrkdwn(note)}` : truth;
}

export function resultFacts(contract: OutputContract, prUrl = contract.prUrl): string[] {
  const url = prUrl ? safeHttpUrl(prUrl) : null;
  return [
    ...(url ? [`${link(url, prLabel(url) ?? "Pull request")} is up.`] : []),
    testSentence(contract),
    ...(contract.ciStatus && contract.ciStatus !== "unknown"
      ? [
          { passed: "CI is green.", failed: "CI failed.", running: "CI is still running." }[
            contract.ciStatus
          ],
        ]
      : []),
    ...(contract.filesChanged.length
      ? [
          `${contract.filesChanged.length} ${contract.filesChanged.length === 1 ? "file" : "files"} changed.`,
        ]
      : []),
  ];
}

export function resultMessage(
  job: JobFacts,
  contract: OutputContract | null,
  concerns: string[] = [],
  limitation: string | null = null,
): string {
  if (!contract)
    return sections([
      `${job.ref}'s worker finished without a result summary. I can't say what changed yet.`,
      ...concerns.map(escapeMrkdwn),
      limitation,
      threadLine(job),
    ]);
  const required = [...new Set([...concerns, ...contract.openQuestions])];
  return sections([
    `${job.ref} is done. ${escapeMrkdwn(tldr(contract.summary))}`,
    resultFacts(contract).join(" "),
    ...required.map(escapeMrkdwn),
    limitation && !required.includes(limitation) ? limitation : null,
  ]);
}

export function failureMessage(job: JobFacts, reason?: string | null): string {
  return lines([
    `${job.ref} stopped before finishing. ${reason ? escapeMrkdwn(reason) : `The ${workerNoun()} stopped before it finished.`}`,
    threadLine(job),
  ]);
}

/** The DM to the owner when the worker waits on a permission prompt. */
export function permissionBlockMessage(ref: string): string {
  return `${ref} needs permission on the ${workerNoun()} before it can continue. Please check it there.`;
}

export function quietNotice(job: JobFacts, quietForMs: number): string {
  return lines([
    `I haven't heard from the ${workerNoun()} on ${job.ref} for ${formatDuration(quietForMs)}. Want me to stop it?`,
    threadLine(job),
  ]);
}

function deliveryOf(brief: Brief): string {
  return brief.openPullRequest
    ? "push the branch and open a draft PR"
    : "commit on the worktree branch, no push, no PR";
}

export function briefPrompt(
  brief: Brief,
  _ref?: string,
  modelLine?: string,
  playbook?: { name: string; trusted: boolean },
): string {
  return lines([
    `I'll ${escapeMrkdwn(brief.goal).replace(/[.!?]+$/, "")} in ${escapeMrkdwn(brief.project)} and ${deliveryOf(brief)}.`,
    ...brief.constraints.map(escapeMrkdwn),
    "I'll keep production and customer data read-only.",
    brief.modelReason && modelLine ? escapeMrkdwn(modelLine) : null,
    playbook?.trusted
      ? `Starting under the owner's trusted playbook ${escapeMrkdwn(playbook.name)}.`
      : "Want me to start?",
  ]);
}

export function fullBrief(brief: Brief, ref?: string): string {
  return lines([
    `${ref ? `${ref}: ` : ""}${escapeMrkdwn(brief.goal)}`,
    `I'll work in ${escapeMrkdwn(brief.project)}${brief.baseRef ? ` from ${escapeMrkdwn(brief.baseRef)}` : ""} and ${deliveryOf(brief)}.`,
    ...brief.constraints.map(escapeMrkdwn),
    `I'll check: ${brief.doneWhen.map(escapeMrkdwn).join("; ")}.`,
    "Production and customer data stay read-only.",
  ]);
}
