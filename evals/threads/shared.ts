import { MAYBE_NOTE, type Person, participantsNote } from "../../lib/slack/participants.ts";

// Helpers for the shared-thread evals (decision 050). Not an eval file. They build the text the
// brain sees in a thread with several people: earlier messages, the People note, and the new
// message with its sender.

export const OWNER_ID = "UOWNER1";
export const ALLOWED_ID = "UALLOWED1";
export const OUTSIDER_ID = "UOUTSIDER1";

export const PEOPLE: Person[] = [
  { id: OWNER_ID, name: "Ann", role: "owner" },
  { id: ALLOWED_ID, name: "Bob", role: "allowed" },
  { id: OUTSIDER_ID, name: "Cy", role: "not on the allow-list" },
];

export interface ThreadTurn {
  sender: string;
  text: string;
  // Earlier thread messages, oldest first, as "<@ID>: text".
  earlier?: string[];
  // True when the message did not tag Sym and may be for someone else.
  maybe?: boolean;
}

export function threadTurn(turn: ThreadTurn): string {
  const earlier = turn.earlier?.length
    ? `<slack_thread_context>\n${turn.earlier.join("\n")}\n</slack_thread_context>\n\n`
    : "";
  const notes = [...(turn.maybe ? [MAYBE_NOTE] : []), participantsNote(PEOPLE, turn.sender)];
  return `${notes.join("\n")}\n\n${earlier}<slack_message>\nsender_id: ${turn.sender}\n<content>\n${turn.text}\n</content>\n</slack_message>`;
}
