import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { loadDatabaseUrl } from './cli-env.js';
import { createDb } from './client.js';
import { workspaces } from './schema/index.js';

// Integration test — runs only when DATABASE_URL is reachable. It creates and
// deletes its own throwaway workspace, so it doesn't depend on (or disturb) the
// seed data. Skips cleanly in environments without a database.
function resolveUrl(): string | undefined {
  try {
    return loadDatabaseUrl();
  } catch {
    return undefined;
  }
}

const databaseUrl = resolveUrl();
const suite = databaseUrl ? describe : describe.skip;

suite('@sym/db round-trip (integration)', () => {
  const { db, close } = createDb(databaseUrl ?? '', { max: 1 });
  const teamId = `T_ROUNDTRIP_${Date.now()}`;

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.slackTeamId, teamId));
    await close();
  });

  it('inserts a workspace and reads it back with defaults applied', async () => {
    const inserted = await db
      .insert(workspaces)
      .values({ slackTeamId: teamId, name: 'Round-trip Test' })
      .returning({ id: workspaces.id });
    expect(inserted[0]?.id).toBeTruthy();

    const found = await db.select().from(workspaces).where(eq(workspaces.slackTeamId, teamId));

    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe('Round-trip Test');
    expect(found[0]?.status).toBe('active');
    expect(found[0]?.createdAt).toBeInstanceOf(Date);
  });
});
