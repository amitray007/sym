import { envSwitch } from "../env-switch.ts";
import { type PersonaName, type PersonaSources, personaName, personaSource } from "../persona.ts";

// What Sym says, privately, to someone who is not on the allow-list (decision 053). Pure: the
// Slack channel decides when to send, and the ephemeral send lives in lib/slack/guard.ts.

// A line has `{owner}` where the owner's tag goes.
export const SPICY_LINES: readonly string[] = [
  "I'm not set up to help you yet. {owner} can give you access.",
  "Ask {owner} for access, then I can help you here.",
];
export const CASUAL_LINES: readonly string[] = [
  "I'm not set up to help you yet. Ask {owner} for access.",
  "{owner} can add you so I can help you here.",
];
export const PLAIN_LINE = "I'm not set up to help you yet. Ask {owner} for access.";
export const NO_OWNER_LINE =
  "I'm not set up to help you yet. Ask the person who runs Sym for access.";

// A casual or spicy persona picks a spicy line this often; the rest are casual.
export const SPICY_SHARE = 0.7;

// `SYM_STRANGER_REPLIES=off` (also `false`, `0`, `no`) turns the unprompted replies off. Anything
// else leaves them on (decision 054).
export function strangerRepliesOn(value: string | undefined): boolean {
  return envSwitch(value, true);
}

export interface StrangerLineInput {
  sources: PersonaSources;
  ownerId: string | undefined;
  /** A number in [0, 1), like Math.random. Tests inject it. */
  random?: () => number;
}

// The persona decides the voice. A pack persona is custom text, so it gets the straight line,
// as it gets the neutral loading messages. With no owner to name, every persona gets the short one.
export function strangerLine({
  sources,
  ownerId,
  random = Math.random,
}: StrangerLineInput): string {
  if (!ownerId) return NO_OWNER_LINE;
  const persona: PersonaName | "pack" =
    personaSource(sources) === "pack"
      ? "pack"
      : (sources.stored ?? personaName(sources.env, sources.warn));
  const tag = `<@${ownerId}>`;
  if (persona === "plain" || persona === "pack") return PLAIN_LINE.replace("{owner}", tag);
  const list = random() < SPICY_SHARE ? SPICY_LINES : CASUAL_LINES;
  const index = Math.min(list.length - 1, Math.floor(random() * list.length));
  return (list[index] ?? PLAIN_LINE).replace("{owner}", tag);
}

const HOUR_MS = 60 * 60 * 1000;
const LIMIT = 2000;

// At most one line per key in a window, in process memory with a size cap (the pattern of
// lib/slack/thread-state.ts). A restart forgets, which only lets one more line through.
export function createStrangerCooldown(windowMs = HOUR_MS, limit = LIMIT) {
  const last = new Map<string, number>();
  return {
    /** Release a failed delivery so a later request can try again. */
    release(key: string): void {
      last.delete(key);
    },
    /** True when the key may get a line now. It then starts the window. */
    claim(key: string, now = Date.now()): boolean {
      const before = last.get(key);
      if (before !== undefined && now - before < windowMs) return false;
      last.delete(key);
      last.set(key, now);
      if (last.size > limit) last.delete(last.keys().next().value as string);
      return true;
    },
  };
}

// One line per person and channel: a channel, or a direct message conversation.
export const strangerKey = (userId: string, channelId: string) => `${userId}:${channelId}`;
