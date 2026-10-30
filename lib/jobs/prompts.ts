import { escapeMrkdwn } from "./messages.ts";

// The text box that Steer and Fix post in the job thread (decision 056). Eve passes no custom
// modal submission to Sym, so the box sits in a message, and pressing Enter sends a
// `block_actions` payload with the text. The block ID carries the job reference.

export type PromptKind = "steer" | "fix";

// The job reference in a prompt's block ID, or nothing when it is not Sym's prompt.
export function refOfPrompt(kind: PromptKind, blockId: string | undefined): string | undefined {
  const match = new RegExp(`^${kind}-(J-\\d+)$`).exec(blockId ?? "");
  return match?.[1];
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
