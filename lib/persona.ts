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
  env?: string | undefined;
  pack?: Pack | undefined;
  readBuiltin?: (name: PersonaName) => string;
  warn?: (message: string) => void;
}

/** The persona text for the brain: the pack's persona file, else the built-in one. */
export function personaInstructions(sources: PersonaSources = {}): string | null {
  const packPersona = sources.pack?.persona?.content.trim();
  if (packPersona) return packPersona;
  const name = personaName(sources.env, sources.warn);
  const text = (sources.readBuiltin ?? readBuiltinPersona)(name).trim();
  return text === "" ? null : text;
}
