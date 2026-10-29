import type { Sql } from "../db.ts";
import { chooseDisplay } from "../display.ts";
import { escapeMrkdwn } from "../jobs/messages.ts";
import type { StoredChoices } from "../ledger/choices.ts";
import { enqueuePost, postStatus } from "../ledger/outbox.ts";
import type { SlackApi } from "../slack/api.ts";
import { deliver } from "./deliver.ts";

interface ChoiceRow extends StoredChoices {
  messageTs: string | null;
  chosenBy: string | null;
  chosenIndex: number | null;
  dispatchedAt: Date | null;
  valid: boolean;
}

// The caller verifies Slack's signature and allow-list. Recheck the actor before consuming the
// row too. A button supplies only the index, never a tool or an approval payload.
export async function takeChoice(
  deps: { sql: Sql; slack: SlackApi; allowed: (user: string) => boolean },
  input: {
    value: string;
    user: string;
    channel: string;
    messageTs: string;
  },
  send: (text: string, key: string) => Promise<unknown>,
): Promise<boolean> {
  if (!deps.allowed(input.user)) return false;
  const match = /^([1-9][0-9]*):([0-2])$/.exec(input.value);
  if (!match) return false;
  const choice = await deps.sql.begin(async (transaction) => {
    const sql = transaction as unknown as Sql;
    const [row] = await sql<ChoiceRow[]>`
      select *, expires_at > now() as valid from conversation_choices where id = ${match[1] ?? "0"}::bigint for update
    `;
    const index = Number(match[2]);
    if (
      !row?.valid ||
      row.channel !== input.channel ||
      row.messageTs !== input.messageTs ||
      !deps.allowed(input.user)
    )
      return false;
    const text = row.choices[index];
    if (
      !text ||
      row.dispatchedAt ||
      (row.chosenBy && (row.chosenBy !== input.user || row.chosenIndex !== index))
    )
      return false;
    await sql`update conversation_choices set chosen_by = ${input.user}, chosen_index = ${index} where id = ${match[1] ?? "0"}::bigint`;
    const visible = `${row.message}\n\n<@${input.user}> chose: ${escapeMrkdwn(text)}`;
    const post = await enqueuePost(sql, {
      idempotencyKey: `choice:${row.id}:picked`,
      method: "chat.update",
      payload: {
        channel: row.channel,
        ts: row.messageTs,
        text: visible,
        blocks: [{ type: "markdown", text: visible }],
      },
      display: chooseDisplay({
        kind: "conversation",
        needsAction: false,
        isNew: true,
        estMinutes: 0,
        steps: 0,
        lines: 1,
        surface: "channel",
        quiet: false,
      }),
    });
    return { id: row.id, text, postId: post.id };
  });
  if (!choice) return false;
  // Commit the actor and label before any external effect. A lost dispatch receipt must not
  // let a replay bind another label to the edit that Slack already accepted.
  await deliver(deps.sql, deps.slack);
  if ((await postStatus(deps.sql, choice.postId)) !== "sent")
    throw new Error("The choice could not be recorded in the conversation.");
  return deps.sql.begin(async (transaction) => {
    const sql = transaction as unknown as Sql;
    const [row] = await sql<ChoiceRow[]>`
      select *, expires_at > now() as valid from conversation_choices where id = ${choice.id}::bigint for update
    `;
    if (!row?.valid || row.dispatchedAt || !deps.allowed(input.user)) return false;
    // Eve's inbound interaction context binds this send to this thread and this Slack user.
    // Its idempotency key makes a retry after a lost receipt safe.
    await send(choice.text, `choice:${row.id}:turn`);
    await sql`update conversation_choices set dispatched_at = now() where id = ${choice.id}::bigint`;
    return true;
  });
}
