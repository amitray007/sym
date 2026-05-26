/**
 * Skill loader for the agent turn path.
 *
 * Queries the `skills` table for enabled rows belonging to a workspace and
 * maps each to a typed `Skill` via `@sym/ext-skills`.
 *
 * Best-effort: any error is logged and swallowed so a bad skill row (e.g.
 * malformed frontmatter, secret guard rejection) NEVER breaks a turn.
 */

import { skills as skillsTable } from '@sym/db';
import { loadSkillFromRow } from '@sym/ext-skills';
import { eq, and } from 'drizzle-orm';

import type { Database } from '@sym/db';
import type { Skill } from '@sym/ext-skills';

/**
 * Load all enabled skills for a workspace, best-effort.
 *
 * Returns `[]` on any DB or parse error; individual bad rows are skipped
 * and logged rather than aborting the whole load.
 */
export async function loadEnabledSkills(db: Database, workspaceId: string): Promise<Skill[]> {
  let rows;
  try {
    rows = await db
      .select()
      .from(skillsTable)
      .where(and(eq(skillsTable.workspaceId, workspaceId), eq(skillsTable.enabled, true)));
  } catch (err) {
    console.warn('[skills] DB query failed; continuing without skills:', err);
    return [];
  }

  const loaded: Skill[] = [];
  for (const row of rows) {
    try {
      loaded.push(
        loadSkillFromRow({
          id: row.id,
          workspaceId: row.workspaceId,
          slug: row.slug,
          name: row.name,
          description: row.description,
          frontmatterJson: row.frontmatterJson as Record<string, unknown>,
          bodyMd: row.bodyMd,
          activationPattern: row.activationPattern ?? null,
        }),
      );
    } catch (err) {
      console.warn(`[skills] skipping skill "${row.slug}" (parse/secret error):`, err);
    }
  }

  return loaded;
}
