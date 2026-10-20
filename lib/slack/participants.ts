// The note that tells the brain who is in a shared thread (decision 050). Names are
// presentation. The user ID and the role decide what a person may do.

export type Role = "owner" | "allowed" | "not on the allow-list";

export interface Person {
  id: string;
  name?: string | undefined;
  role: Role;
}

const NAME_TTL_MS = 60 * 60 * 1000;
const MAX_NAMES = 500;
const MAX_LISTED = 10;

// A display name is free text from the person. Keep letters, digits, and a few marks, so a name
// cannot carry a tag, a code fence, or a second line of instructions.
export function cleanName(name: string): string | undefined {
  const cleaned = name
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ._'-]/gu, "")
    .trim()
    .slice(0, 40);
  return cleaned || undefined;
}

export interface UserLookup {
  request(operation: string, body: unknown): Promise<{ ok?: boolean; [key: string]: unknown }>;
}

// Display names by user ID, kept in memory for an hour. A failed lookup gives no name.
export function createNameCache(now: () => number = Date.now) {
  const names = new Map<string, { name: string | undefined; expires: number }>();
  return async function nameOf(slack: UserLookup, id: string): Promise<string | undefined> {
    const hit = names.get(id);
    if (hit && hit.expires > now()) return hit.name;
    try {
      const response = await slack.request("users.info", { user: id });
      const profile = (response.user as { profile?: Record<string, unknown> } | undefined)?.profile;
      const raw = [profile?.display_name, profile?.real_name].find(
        (value): value is string => typeof value === "string" && value.trim() !== "",
      );
      const name = response.ok === false || !raw ? undefined : cleanName(raw);
      names.set(id, { name, expires: now() + NAME_TTL_MS });
      if (names.size > MAX_NAMES) names.delete(names.keys().next().value as string);
      return name;
    } catch {
      return undefined;
    }
  };
}

export const nameOf = createNameCache();

export function participantsNote(people: readonly Person[], senderId: string): string {
  const listed = people
    .slice(0, MAX_LISTED)
    .map((p) => `<@${p.id}> (${p.name ? `${p.name}, ` : ""}${p.role})`);
  const more = people.length > MAX_LISTED ? `, and ${people.length - MAX_LISTED} more` : "";
  return `People in this thread: ${listed.join(", ")}${more}. This message is from <@${senderId}>.`;
}

export const MAYBE_NOTE =
  "Other people are in this thread, and this message did not tag Sym. Reply only if it is meant " +
  "for Sym. Otherwise call no_reply.";
