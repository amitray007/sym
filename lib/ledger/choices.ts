import { z } from "zod";
import type { Sql } from "../db.ts";
import { json } from "./jobs.ts";

export const CHOICE_ACTION_ID = "sym_choice";
export const ChoiceLabels = z
  .array(z.string().trim().min(1).max(30))
  .min(2)
  .max(3)
  .refine((labels) => new Set(labels).size === labels.length, "Choices must be distinct");

export interface StoredChoices {
  id: string;
  channel: string;
  threadTs: string | null;
  message: string;
  choices: string[];
}

// Labels are conversation input only. They cannot encode a tool, approval, or worker action.
export async function storeChoices(
  sql: Sql,
  input: Omit<StoredChoices, "id"> & { key: string; jobId?: number },
): Promise<StoredChoices> {
  const choices = ChoiceLabels.parse(input.choices);
  const [row] = await sql<StoredChoices[]>`
    insert into conversation_choices (request_key, job_id, channel, thread_ts, message, choices)
    values (${input.key}, ${input.jobId ?? null}, ${input.channel}, ${input.threadTs}, ${input.message}, ${json(sql, choices)})
    on conflict (request_key) do update set request_key = excluded.request_key returning *
  `;
  if (!row) throw new Error("Choice store returned no row");
  return { ...row, id: String(row.id) };
}

export function choiceBlocks(stored: StoredChoices): Record<string, unknown>[] {
  return [
    {
      type: "actions",
      block_id: `choices-${stored.id}`,
      elements: stored.choices.map((label, index) => ({
        type: "button",
        action_id: `${CHOICE_ACTION_ID}_${index}`,
        text: { type: "plain_text", text: label },
        value: `${stored.id}:${index}`,
      })),
    },
  ];
}
