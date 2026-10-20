import { type PersonaName, type PersonaSources, personaName, personaSource } from "../persona.ts";

// What Sym says, privately, to someone who is not on the allow-list (decision 053). Pure: the
// Slack channel decides when to send, and the ephemeral send lives in lib/slack/guard.ts.

// A line has `{owner}` where the owner's tag goes.
export const SPICY_LINES: readonly string[] = [
  "I'm a bouncer with a very short list, and you're not on it. {owner} owns the club.",
  "New phone, who dis? Kidding. Only {owner}'s people get my attention.",
  "I'd answer, but {owner} would take away my coffee privileges.",
  "Beep boop, not authorized. Go bribe {owner}.",
  "Bold of you to assume I work for you. Talk to my leader, {owner}.",
  "You've reached a bot that doesn't know you. Please hold for {owner}. Forever.",
  "Sir, this is a private Slack agent. {owner} does the hiring.",
  "I only take orders from my people. You can apply with {owner}.",
  "Nice try. My loyalty belongs to {owner}, and it isn't for sale. Okay, it might be. Ask them.",
  "Error 403: vibes not verified. Contact {owner}.",
  "I don't talk to strangers. Not even cool ones. {owner} decides who's cool.",
  "You're not on the guest list. {owner} has the clipboard.",
  "Request received, and ignored. Take it up with management, {owner}.",
  "I'm not ignoring you, I'm just contractually loyal to {owner}.",
  "My boss said not to talk to people I don't know. That's you. Ask {owner}.",
];

export const CASUAL_LINES: readonly string[] = [
  "I'd love to help, but my boss {owner} keeps me on a short leash. Ask them.",
  "My manager {owner} says I'm not allowed to talk to strangers.",
  "I'm flattered, but I'm spoken for. {owner} can add you to my list.",
  "That's above my pay grade, and I don't get paid. Ask {owner}.",
  "Access denied, but politely. {owner} holds the keys.",
  "Hi! I only work for a few people here. {owner} can add you.",
  "Sorry, I'm not set up to help you yet. {owner} can fix that.",
  "I'd help if I could. Ask {owner} to put you on my list.",
  "You found me! Sadly I can't help you until {owner} says so.",
  "I'm a bit of an introvert. {owner} handles my introductions.",
  "Ooh, a new face. {owner} decides who I work with, so ask them.",
  "I can't take requests from you yet. {owner} is the one to ask.",
  "Hello there. I'm on a private plan, and {owner} manages the guest list.",
  "I'd chat, but rules are rules. {owner} makes the rules.",
  "Not my call, sadly. {owner} decides who I help.",
];

export const PLAIN_LINE = "Sym only works for people on its allow-list. Ask {owner} for access.";
export const NO_OWNER_LINE = "Sym only works for people on its allow-list.";

// A casual or spicy persona picks a spicy line this often; the rest are casual.
export const SPICY_SHARE = 0.7;

// `SYM_STRANGER_REPLIES=off` turns the unprompted replies off. Anything else leaves them on.
export function strangerRepliesOn(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== "off";
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
