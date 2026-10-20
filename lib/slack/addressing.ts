// Who a message in a shared Slack thread is meant for (decision 050). Sym joins a thread with
// several people only when a message is meant for it. This module is pure: the Slack channel
// gathers the inputs and acts on the answer.

export const LISTEN_MODES = ["all", "mention-only"] as const;
export type ListenMode = (typeof LISTEN_MODES)[number];

// reply: start a turn. maybe: start a quiet turn and let the brain decide. skip: do nothing.
export type Addressing = "reply" | "maybe" | "skip";

// What a thread fetch showed about the people in it. `ids` are human Slack users. `complete` is
// false when the fetch failed, came back empty, or may have missed messages.
export interface ThreadPeople {
  ids: readonly string[];
  complete: boolean;
}

// Eve reads at most the first 50 messages of a thread (THREAD_REFRESH_LIMIT). A thread that
// reached that size may have more people than the fetch saw.
export const THREAD_FETCH_LIMIT = 50;

export function threadPeople(messageCount: number, ids: readonly string[]): ThreadPeople {
  return { ids, complete: ids.length > 0 && messageCount < THREAD_FETCH_LIMIT };
}

export interface TriageInput {
  senderId: string;
  text: string;
  // True when the text tags Sym (`<@BOT>`). Eve reports it from the event.
  mentionsBot: boolean;
  // The name people use for Sym in words.
  botName: string;
  listenMode: ListenMode;
  people: ThreadPeople;
  // The person Sym last served in this thread.
  partnerId?: string | undefined;
}

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

export function mentionedUserIds(text: string): string[] {
  return [...text.matchAll(MENTION)].map((match) => match[1] as string);
}

// Code and quotes show a name without addressing it.
function withoutQuotedText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/^&gt;.*$/gm, " ")
    .replace(/^>.*$/gm, " ")
    .replace(MENTION, " ");
}

// True when the text says the bot's name as a word, in any case: "sym, what is the status?"
export function namesBot(text: string, botName: string): boolean {
  const name = botName.trim();
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(
    withoutQuotedText(text),
  );
}

// The first matching rule wins. A message that tags Sym is meant for Sym. A message that tags
// someone else is meant for them. In a solo thread every message is meant for Sym. In a shared
// thread only the person Sym serves, or a message that says Sym's name, may start a quiet turn.
export function triageThreadMessage(input: TriageInput): Addressing {
  if (input.mentionsBot) return "reply";
  if (input.listenMode === "mention-only") return "skip";
  if (mentionedUserIds(input.text).some((id) => id !== input.senderId)) return "skip";
  const others = input.people.ids.filter((id) => id !== input.senderId);
  if (input.people.complete && others.length === 0) return "reply";
  if (input.partnerId && input.partnerId === input.senderId) return "maybe";
  if (namesBot(input.text, input.botName)) return "maybe";
  return "skip";
}
