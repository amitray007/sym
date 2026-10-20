import type { Sql } from "./db.ts";
import { mayDecideAsOwner } from "./owner.ts";
import type { Pack } from "./pack/load.ts";
import {
  PERSONAS,
  type PersonaName,
  type PersonaSource,
  personaName,
  personaSource,
} from "./persona.ts";

// The persona the owner sets from Slack (decision 046). It lives in the `settings` table under
// one key. Order of precedence: pack persona file, this setting, SYM_PERSONA, then casual.

const KEY = "persona";

export const PERSONA_OWNER_ONLY = "Only the owner can change this.";

/** The stored persona, or undefined when none is set or the row holds an unknown name. */
export async function getStoredPersona(sql: Sql): Promise<PersonaName | undefined> {
  const [row] = await sql<{ value: string }[]>`select value from settings where key = ${KEY}`;
  return PERSONAS.find((name) => name === row?.value);
}

export async function setStoredPersona(sql: Sql, name: PersonaName, userId: string): Promise<void> {
  await sql`
    insert into settings (key, value, updated_by) values (${KEY}, ${name}, ${userId})
    on conflict (key) do update
      set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()
  `;
}

/** Reads the stored persona. A database error warns once and gives undefined (fail open). */
export async function storedPersonaOrNone(
  sql: () => Sql,
  warn: (message: string, error?: unknown) => void = console.warn,
): Promise<PersonaName | undefined> {
  try {
    return await getStoredPersona(sql());
  } catch (error) {
    warn("persona: could not read the stored persona. Using the environment default.", error);
    return undefined;
  }
}

export interface PersonaStatus {
  name: PersonaName;
  source: PersonaSource;
}

export function personaStatus(
  pack: Pack | undefined,
  stored: PersonaName | undefined,
  env: string | undefined,
  warn?: (message: string) => void,
): PersonaStatus {
  return {
    name: stored ?? personaName(env, warn),
    source: personaSource({ pack, stored, env }),
  };
}

const SOURCE_NOTE: Record<PersonaSource, string> = {
  pack: "The pack's persona file decides, so this setting has no effect.",
  slack: "Set from Slack.",
  env: "Set by `SYM_PERSONA`.",
  default: "The default.",
};

/** The `/sym persona` answer with no argument. */
export function describePersona(status: PersonaStatus): string {
  const current = status.source === "pack" ? "a persona from the pack" : `\`${status.name}\``;
  return [
    `Persona: ${current}. ${SOURCE_NOTE[status.source]}`,
    `Choices: ${PERSONAS.map((name) => `\`${name}\``).join(", ")}. Use \`/sym persona <name>\`.`,
  ].join("\n");
}

export interface ChangePersonaInput {
  sql: Sql;
  pack: Pack | undefined;
  userId: string | undefined;
  name: PersonaName;
  env?: Record<string, string | undefined>;
}

/**
 * Sets the persona for the owner. Refuses anyone else and refuses when the pack decides. The new
 * persona applies from the next session.
 */
export async function changePersona(input: ChangePersonaInput): Promise<string> {
  const env = input.env ?? process.env;
  if (!input.userId || !mayDecideAsOwner(input.userId, input.pack, env)) {
    return PERSONA_OWNER_ONLY;
  }
  if (personaSource({ pack: input.pack }) === "pack") {
    return "The pack's persona file decides the persona, so Sym stores nothing.";
  }
  await setStoredPersona(input.sql, input.name, input.userId);
  return `Persona set to \`${input.name}\`. It applies from the next conversation.`;
}
