import { workerLabel } from "../worker-label.ts";
import { FIX_TEXT_ACTION_ID, STEER_TEXT_ACTION_ID } from "./card.ts";
import { escapeMrkdwn } from "./messages.ts";
import { STEER_TEXT_MAX } from "./steer.ts";

// The text box that Steer and Fix post in the job thread (decision 056). Eve passes no custom
// modal submission to Sym, so the box sits in a message, and pressing Enter sends a
// `block_actions` payload with the text. The block ID carries the job reference.

export type PromptKind = "steer" | "fix";

const ACTION: Record<PromptKind, string> = { steer: STEER_TEXT_ACTION_ID, fix: FIX_TEXT_ACTION_ID };

export function promptBlockId(kind: PromptKind, ref: string): string {
  return `${kind}-${ref}`;
}

// The job reference in a prompt's block ID, or nothing when it is not Sym's prompt.
export function refOfPrompt(kind: PromptKind, blockId: string | undefined): string | undefined {
  const match = new RegExp(`^${kind}-(J-\\d+)$`).exec(blockId ?? "");
  return match?.[1];
}

export function promptPost(
  kind: PromptKind,
  ref: string,
): { text: string; blocks: Record<string, unknown>[] } {
  const worker = workerLabel();
  const question =
    kind === "steer"
      ? `What should ${worker} do differently on ${ref}?`
      : `What should ${worker} change in ${ref}?`;
  return {
    text: question,
    blocks: [
      {
        type: "input",
        block_id: promptBlockId(kind, ref),
        dispatch_action: true,
        label: { type: "plain_text", text: question },
        element: {
          type: "plain_text_input",
          action_id: ACTION[kind],
          max_length: STEER_TEXT_MAX,
          dispatch_action_config: { trigger_actions_on: ["on_enter_pressed"] },
          placeholder: { type: "plain_text", text: "Type it, then press Enter" },
        },
      },
    ],
  };
}

// What the prompt turns into once someone sends it: the words and the outcome, no text box.
export function answeredPrompt(
  user: string,
  text: string,
  outcome: string,
): { text: string; blocks: Record<string, unknown>[] } {
  const line = `<@${user}>: ${escapeMrkdwn(text)}\n${escapeMrkdwn(outcome)}`;
  return { text: line, blocks: [{ type: "section", text: { type: "mrkdwn", text: line } }] };
}
