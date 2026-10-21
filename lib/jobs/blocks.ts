import { workerLabel, workerNoun } from "../worker-label.ts";
import {
  buttonUrl,
  CLOSE_ACTION_ID,
  FIX_ACTION_ID,
  jobButton,
  LOOKS_GOOD_ACTION_ID,
  openPrButton,
} from "./card.ts";
import type { OutputContract } from "./contract.ts";
import {
  duration,
  escapeMrkdwn,
  failureMessage,
  type JobFacts,
  resultMessage,
  resultView,
} from "./messages.ts";
import { CONCERNS_HEADER } from "./verify.ts";
import { WRITTEN_MAX } from "./writer.ts";

// Block Kit for the result and failure posts (decision 047). Each builder returns the blocks and
// the plain `text` fallback that Slack shows in notifications and to screen readers. The text is
// the mrkdwn message from messages.ts, so both forms say the same thing. These functions are pure
// and stay free of Node.js builtins: the workflow bundle reaches them.

export type Block = Record<string, unknown>;

export interface BlockPost {
  text: string;
  blocks: Block[];
}

// Slack's limits: 3000 characters in a section, 150 in a header, 50 blocks in a message.
export const SECTION_MAX = 3000;
export const HEADER_MAX = 150;
export const MAX_BLOCKS = 50;
const ITEM_MAX = 500;
const MAX_ITEMS = 10;

/** Cuts plain text to `max` characters and marks the cut with an ellipsis. */
export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Escapes worker text for mrkdwn and keeps the escaped result within `max` characters. */
export function safeMrkdwn(text: string, max: number): string {
  let budget = max;
  for (;;) {
    const out = escapeMrkdwn(clipText(text, budget));
    if (out.length <= max || budget <= 1) return out.length <= max ? out : out.slice(0, max);
    // Escapes add characters, so cut more raw text until the escaped text fits.
    budget -= out.length - max;
  }
}

function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text: clipText(text, SECTION_MAX) } };
}

function header(emoji: string, job: JobFacts, tail?: string): Block {
  const end = tail ? ` · ${tail}` : "";
  const start = `${emoji} ${job.ref} · `;
  const title = clipText(job.title, Math.max(1, HEADER_MAX - start.length - end.length));
  return {
    type: "header",
    text: { type: "plain_text", text: clipText(`${start}${title}${end}`, HEADER_MAX), emoji: true },
  };
}

function context(parts: string[]): Block | null {
  const elements = parts.filter((part) => part !== "").map((text) => ({ type: "mrkdwn", text }));
  return elements.length > 0 ? { type: "context", elements: elements.slice(0, 10) } : null;
}

// Rich text holds the text as typed, so a list item takes no mrkdwn escapes.
function numberedList(items: string[]): Block {
  const shown = items.slice(0, MAX_ITEMS).map((item) => clipText(item, ITEM_MAX));
  if (items.length > MAX_ITEMS) shown.push(`…and ${items.length - MAX_ITEMS} more`);
  return {
    type: "rich_text",
    elements: [
      {
        type: "rich_text_list",
        style: "ordered",
        elements: shown.map((text) => ({
          type: "rich_text_section",
          elements: [{ type: "text", text }],
        })),
      },
    ],
  };
}

function checklist(title: string, items: string[]): string {
  const shown = items.slice(0, MAX_ITEMS).map((item) => `☐ ${safeMrkdwn(item, ITEM_MAX)}`);
  if (items.length > MAX_ITEMS) shown.push(`…and ${items.length - MAX_ITEMS} more`);
  return [title, ...shown].join("\n");
}

function present(blocks: (Block | null | false | "")[]): Block[] {
  return blocks.filter((block): block is Block => !!block).slice(0, MAX_BLOCKS);
}

function threadContext(job: JobFacts): string {
  return job.workerThreadId
    ? `${workerLabel()} thread: \`${escapeMrkdwn(job.workerThreadId)}\``
    : "";
}

export function resultPost(
  job: JobFacts,
  contract: OutputContract | null,
  concerns: string[] = [],
  verdict: string | null = null,
): BlockPost {
  const text = resultMessage(job, contract, concerns, verdict);
  const view = resultView(job, contract, concerns, verdict);
  const head = header(view.emoji, job, view.duration);

  if (view.noResult) {
    return {
      text,
      blocks: present([
        head,
        section(`*tl;dr* ${view.gist}`),
        view.verdict && section(safeMrkdwn(view.verdict, SECTION_MAX)),
        context([threadContext(job)]),
        resultActions(job.ref, null, true),
      ]),
    };
  }

  const prUrl = view.pr ? buttonUrl(view.pr.url) : null;
  const facts = [
    view.tests && `tests: ${safeMrkdwn(view.tests, 200)}`,
    view.filesChanged > 0 &&
      `${view.filesChanged} ${view.filesChanged === 1 ? "file" : "files"} changed`,
  ].filter((part): part is string => typeof part === "string" && part !== "");

  return {
    text,
    blocks: present([
      head,
      view.gist !== "" && section(`*tl;dr* ${safeMrkdwn(view.gist, SECTION_MAX - 10)}`),
      view.verdict && section(safeMrkdwn(view.verdict, SECTION_MAX)),
      view.concernsHeader !== null && section(view.concernsHeader),
      view.concernsHeader !== null && numberedList(view.concerns),
      view.questions.length > 0 && section(checklist("*open questions*", view.questions)),
      context(facts),
      resultActions(job.ref, prUrl, true),
    ]),
  };
}

// A result the `writer` subagent wrote (decision 062). The text is the writer's, in Slack's
// markdown block, with no template. Sym keeps three things: the check concerns, because a worker
// report must not be able to talk them away; a footer with the job, its time, and its facts; and
// the buttons.
export function writtenPost(
  job: JobFacts,
  contract: OutputContract,
  concerns: string[],
  written: string,
  prUrl: string | null,
): BlockPost {
  const flagged = concerns.length > 0;
  const emoji = flagged ? "⚠️" : "✅";
  const time = duration(job);
  const files = contract.filesChanged.length;
  const firstLine = written.split("\n").find((line) => line.trim() !== "") ?? "";
  return {
    text: clipText(`${emoji} ${job.ref} · ${firstLine}`, HEADER_MAX * 2),
    blocks: present([
      { type: "markdown", text: clipText(written, WRITTEN_MAX) },
      flagged && section(CONCERNS_HEADER),
      flagged && numberedList(concerns),
      context([
        `${emoji} ${job.ref}${time ? ` · ${time}` : ""}`,
        contract.tests && `tests: ${safeMrkdwn(contract.tests, 200)}`,
        files > 0 ? `${files} ${files === 1 ? "file" : "files"} changed` : "",
      ]),
      resultActions(job.ref, prUrl ? buttonUrl(prUrl) : null, true),
    ]),
  };
}

// Open PR, then Looks good, Fix, and Close (decision 056). A failure gets Fix and Close only.
function resultActions(ref: string, prUrl: string | null, done: boolean): Block {
  return {
    type: "actions",
    block_id: `job-${ref}-result`,
    elements: [
      ...(prUrl ? [openPrButton(prUrl)] : []),
      ...(done ? [jobButton(LOOKS_GOOD_ACTION_ID, "Looks good", ref, "primary")] : []),
      jobButton(FIX_ACTION_ID, "Fix…", ref),
      jobButton(CLOSE_ACTION_ID, "Close", ref),
    ],
  };
}

export function failurePost(job: JobFacts, reason?: string | null): BlockPost {
  const time = duration(job);
  return {
    text: failureMessage(job, reason),
    blocks: present([
      header("❌", job, time ? `failed in ${time}` : "failed"),
      section(
        reason
          ? safeMrkdwn(reason, SECTION_MAX)
          : `the ${workerNoun()} stopped before it finished.`,
      ),
      context([threadContext(job)]),
      resultActions(job.ref, null, false),
    ]),
  };
}
