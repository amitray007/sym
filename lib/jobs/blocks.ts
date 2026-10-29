import { feedbackBlocks } from "../feedback/feedback.ts";
import { buttonUrl, openPrButton } from "./card.ts";
import { hasOutcomeClaim, type OutputContract } from "./contract.ts";
import {
  duration,
  escapeMrkdwn,
  failureMessage,
  type JobFacts,
  resultMessage,
} from "./messages.ts";
import { resultTokens, WRITTEN_MAX, type WriterOutput } from "./writer.ts";

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

// A markdown block supports 12,000 characters. Larger deterministic results use several
// section blocks without dropping required concerns. The full notification text is never cut.
function textBlocks(text: string): Block[] {
  if (text.length <= 12_000) return [{ type: "markdown", text }];
  const blocks: Block[] = [];
  for (let i = 0; i < text.length; i += SECTION_MAX) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: text.slice(i, i + SECTION_MAX) },
    });
  }
  return blocks;
}

function meta(job: JobFacts): Block {
  const time = duration(job);
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: `${job.ref}${time ? ` · ${time}` : ""}` }],
  };
}

function resultActions(prUrl: string | null, ciUrl?: string): Block[] {
  const pr = buttonUrl(prUrl);
  const ci = buttonUrl(ciUrl);
  const elements = [
    ...(pr ? [openPrButton(pr)] : []),
    ...(ci
      ? [
          {
            type: "button",
            action_id: "sym_job_ci",
            text: { type: "plain_text", text: "CI run" },
            url: ci,
          },
        ]
      : []),
  ];
  return elements.length ? [{ type: "actions", elements }] : [];
}

export function resultPost(
  job: JobFacts,
  contract: OutputContract | null,
  concerns: string[] = [],
  limitation: string | null = null,
): BlockPost {
  const text = resultMessage(job, contract, concerns, limitation);
  return {
    text,
    blocks: [
      ...textBlocks(text),
      meta(job),
      ...resultActions(contract?.prUrl ?? null, contract?.ciUrl),
      ...feedbackBlocks(),
    ],
  };
}

export function writtenPost(
  job: JobFacts,
  contract: OutputContract,
  concerns: string[],
  written: string | WriterOutput,
  prUrl: string | null,
  limitation: string | null = null,
): BlockPost {
  const output = typeof written === "string" ? { text: written } : written;
  const body = defuse(output.text.slice(0, WRITTEN_MAX));
  if (hasOutcomeClaim(body)) return resultPost(job, { ...contract, prUrl }, concerns, limitation);
  const tokens = resultTokens(contract, concerns, prUrl);
  const used = new Set<string>();
  const expanded = body.replace(/\{\{([a-z]+\d*)\}\}/g, (token, id: string) => {
    const fact = tokens[id];
    if (!fact) return token;
    used.add(id);
    return /^[cq]\d+$/.test(id) ? escapeMrkdwn(fact) : fact;
  });
  // Legacy prose can already contain a full fact. Compare visible link labels as well.
  const visible = (text: string) =>
    text
      .replace(/<[^|<>]+\|([^<>]+)>/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const missing = Object.entries(tokens).filter(
    ([id, fact]) =>
      !used.has(id) &&
      (/^[cq]\d+$/.test(id) ||
        (!visible(expanded).includes(visible(escapeMrkdwn(fact))) &&
          !visible(expanded).includes(visible(fact)))),
  );
  const facts = missing.filter(([id]) => !/^[cq]\d+$/.test(id)).map(([, fact]) => fact);
  const additions = [
    ...missing.filter(([id]) => /^[cq]\d+$/.test(id)).map(([, fact]) => escapeMrkdwn(fact)),
    ...(facts.length ? [`${facts.map((fact) => fact.replace(/\.$/, "")).join(". ")}.`] : []),
  ];
  if (
    limitation &&
    !visible(expanded).includes(visible(limitation)) &&
    !additions.includes(escapeMrkdwn(limitation))
  )
    additions.push(escapeMrkdwn(limitation));
  const text = [expanded, additions.join(" ")].filter(Boolean).join("\n\n");
  return {
    text,
    blocks: [
      ...textBlocks(text),
      meta(job),
      ...resultActions(prUrl, contract.ciUrl),
      ...feedbackBlocks(),
    ],
  };
}

// Model text shaped by a worker report must not ping anyone: Slack's special tokens, such as
// <!channel>, <!here>, <@U123>, and <#C123>, lose their angle brackets and stay as plain text.
export function defuse(text: string): string {
  return text
    .replace(/<([!@#][^<>]*)>/g, "$1")
    .replace(/@(channel|here|everyone)\b/gi, "@\u200b$1");
}

export function failurePost(job: JobFacts, reason?: string | null): BlockPost {
  const text = failureMessage(job, reason);
  return { text, blocks: [...textBlocks(text), meta(job), ...feedbackBlocks()] };
}
