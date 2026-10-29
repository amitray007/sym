import type { Sql } from "../db.ts";
import { envSwitch } from "../env-switch.ts";
import { markUnclean } from "../learning/trust.ts";
import type { Pack } from "../pack/load.ts";

// Feedback from people (docs/learning.md): feedback buttons under replies, reactions on Sym's
// messages, and fixes. This module only records rows. Learning reads them later, and a row never
// changes behavior by itself.

export type FeedbackKind = "thumbs_up" | "thumbs_down" | "reaction" | "fix";

export interface NewFeedback {
  jobId?: number | null;
  slackUser: string;
  kind: FeedbackKind;
  value?: string;
  channel?: string | null;
  messageTs?: string | null;
}

export interface Feedback {
  id: number;
  jobId: number | null;
  slackUser: string;
  kind: FeedbackKind;
  value: string;
  channel: string | null;
  messageTs: string | null;
  createdAt: Date;
}

// Sym's own action_id prefix. Eve keeps "eve_input:" for its controls, so these clicks reach
// onInteraction.
export const FEEDBACK_ACTION_ID = "sym_feedback";

type Env = Record<string, string | undefined>;

// `SYM_FEEDBACK=off` (also `false`, `0`, `no`, any case) turns the buttons off. Anything else,
// including unset, leaves them on. Handlers stay, so clicks on old messages still record.
export function feedbackEnabled(env: Env = process.env): boolean {
  return envSwitch(env.SYM_FEEDBACK, true);
}

// The buttons under a job result. Chat replies do not use this helper. A `context_actions` block holds Slack's native feedback buttons.
// Empty when the owner turned feedback off.
export function feedbackBlocks(env: Env = process.env): Record<string, unknown>[] {
  if (!feedbackEnabled(env)) return [];
  return [
    {
      type: "context_actions",
      elements: [
        {
          type: "feedback_buttons",
          action_id: FEEDBACK_ACTION_ID,
          positive_button: { text: { type: "plain_text", text: "Helpful" }, value: "up" },
          negative_button: { text: { type: "plain_text", text: "Not helpful" }, value: "down" },
        },
      ],
    },
  ];
}

export function kindOfButton(value: string | undefined): "thumbs_up" | "thumbs_down" | undefined {
  if (value === "up") return "thumbs_up";
  if (value === "down") return "thumbs_down";
  return undefined;
}

// Slack names the thumbs "+1" and "-1", and adds "::skin-tone-N" for a tone.
export function kindOfReaction(name: string): FeedbackKind {
  const base = (name.split("::")[0] ?? "").toLowerCase();
  if (base === "+1" || base === "thumbsup") return "thumbs_up";
  if (base === "-1" || base === "thumbsdown") return "thumbs_down";
  return "reaction";
}

const normalize = (row: Feedback): Feedback => ({
  ...row,
  id: Number(row.id),
  jobId: row.jobId === null ? null : Number(row.jobId),
});

// Saves one piece of feedback. The same person's same reaction to the same message counts once.
// Returns undefined for a repeat.
// `pack` names the owner for a trust notice; without it, SYM_OWNER_SLACK_USER does.
export async function recordFeedback(
  sql: Sql,
  input: NewFeedback,
  pack?: Pack,
): Promise<Feedback | undefined> {
  const [row] = await sql<Feedback[]>`
    insert into feedback (job_id, slack_user, kind, value, channel, message_ts)
    values (
      ${input.jobId ?? null}, ${input.slackUser}, ${input.kind}, ${input.value ?? ""},
      ${input.channel ?? null}, ${input.messageTs ?? null}
    )
    on conflict (slack_user, kind, message_ts, value)
      where message_ts is not null and kind <> 'fix'
    do nothing
    returning *
  `;
  // A 👎 or a Fix on a job breaks its playbook's clean run (decision 059).
  if (row && input.jobId && (input.kind === "thumbs_down" || input.kind === "fix")) {
    await markUnclean(
      sql,
      input.jobId,
      `${input.kind === "fix" ? "a Fix" : "a 👎"} on J-${input.jobId}`,
      pack,
    );
  }
  return row && normalize(row);
}

// The job whose thread this is. A feedback button sits under a reply in a job's thread. A job in
// its own code channel has no thread: the whole channel is its, and its old thread still finds it
// through the origin columns (decision 067).
export async function jobIdOfThread(
  sql: Sql,
  channel: string,
  threadTs: string,
): Promise<number | null> {
  const [row] = await sql<{ id: string }[]>`
    select id from jobs
    where (slack_channel = ${channel} and (slack_thread_ts = ${threadTs} or code_channel))
      or (origin_channel = ${channel} and origin_thread_ts = ${threadTs})
    order by id desc limit 1
  `;
  return row ? Number(row.id) : null;
}

// The job that owns a Slack message Sym posted: its card, or any post from the outbox.
export async function jobIdOfMessage(
  sql: Sql,
  channel: string,
  ts: string,
): Promise<number | null> {
  const [card] = await sql<{ id: string }[]>`
    select id from jobs where card_ts = ${ts} and slack_channel = ${channel} limit 1
  `;
  if (card) return Number(card.id);
  const [post] = await sql<{ jobId: string }[]>`
    select o.job_id from outbox o join jobs j on j.id = o.job_id
    where o.slack_ts = ${ts} and (j.slack_channel = ${channel} or o.payload ->> 'channel' = ${channel})
    order by o.id desc limit 1
  `;
  return post ? Number(post.jobId) : null;
}
