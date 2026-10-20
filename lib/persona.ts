import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pack } from "./pack/load.ts";

// The brain's voice (decision 044). A persona is a Markdown file added to the brain's
// instructions. It shapes the brain's own replies only. Messages that Sym's code builds stay
// neutral, and worker threads never get a persona.

export const PERSONAS = ["plain", "casual", "spicy"] as const;
export type PersonaName = (typeof PERSONAS)[number];
export const DEFAULT_PERSONA: PersonaName = "casual";

/** The built-in persona named by `SYM_PERSONA`. An unknown value warns and gives the default. */
export function personaName(
  value: string | undefined,
  warn: (message: string) => void = console.warn,
): PersonaName {
  const wanted = value?.trim().toLowerCase();
  if (!wanted) return DEFAULT_PERSONA;
  const found = PERSONAS.find((name) => name === wanted);
  if (found) return found;
  warn(
    `SYM_PERSONA "${value?.trim().slice(0, 40)}" is not one of ${PERSONAS.join(", ")}. Using ${DEFAULT_PERSONA}.`,
  );
  return DEFAULT_PERSONA;
}

/** Reads a built-in persona file. The agent folder ships with the image, next to the app. */
export function readBuiltinPersona(name: PersonaName, root = process.cwd()): string {
  return readFileSync(join(root, "agent", "personas", `${name}.md`), "utf8");
}

export interface PersonaSources {
  /** The persona the owner set from Slack. It beats the environment. */
  stored?: PersonaName | undefined;
  env?: string | undefined;
  pack?: Pack | undefined;
  readBuiltin?: (name: PersonaName) => string;
  warn?: (message: string) => void;
}

/** The persona text for the brain: pack file, else the Slack setting, else `SYM_PERSONA`. */
export function personaInstructions(sources: PersonaSources = {}): string | null {
  const packPersona = sources.pack?.persona?.content.trim();
  if (packPersona) return packPersona;
  const name = sources.stored ?? personaName(sources.env, sources.warn);
  const text = (sources.readBuiltin ?? readBuiltinPersona)(name).trim();
  return text === "" ? null : text;
}

/** Where the effective persona comes from, highest priority first. */
export type PersonaSource = "pack" | "slack" | "env" | "default";

export function personaSource(sources: PersonaSources): PersonaSource {
  if (sources.pack?.persona?.content.trim()) return "pack";
  if (sources.stored) return "slack";
  return sources.env?.trim() ? "env" : "default";
}

// Status lines for Slack's thinking indicator, one list per persona. Slack rotates them while
// the brain works. Each is short (the status line is cut at 50 characters) and generic.
export const LOADING_MESSAGES: Record<PersonaName, readonly string[]> = {
  plain: ["Working..."],
  casual: ["on it...", "thinking...", "one sec...", "looking into it..."],
  spicy: ["cooking...", "reading your mess...", "bestie hold on...", "give me a sec, chief..."],
};

/** The status lines for a persona. A pack persona is custom text, so it gets the neutral list. */
export function loadingMessages(sources: PersonaSources): readonly string[] {
  if (personaSource(sources) === "pack") return LOADING_MESSAGES.plain;
  return LOADING_MESSAGES[sources.stored ?? personaName(sources.env, sources.warn)];
}
