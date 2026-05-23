/**
 * promptfoo custom provider for the cascade correctness eval.
 *
 * Builds an in-memory fake of the cascade resolver using the given `layers`
 * var, runs resolveCascade, and returns the JSON-serialised SoulCascade.
 *
 * Usage in cascade.yaml:
 *   providers:
 *     - id: "file://./cascade-provider.js"
 */

export async function callApi(prompt, { vars }) {
  const { resolveCascade, clearCascadeCache } = await import('../dist/index.js');

  const layers = vars.layers ?? [];
  const channelId = vars.channelId;
  const userId = vars.userId;
  const workspaceId = vars.workspaceId ?? 'ws_eval_001';

  clearCascadeCache();

  // Build a fake DB that returns only the specified rows.
  const fakeDb = {
    select() {
      return {
        from() {
          return {
            where() {
              // Return the rows filtered to the relevant context.
              const filtered = layers
                .filter((row) => {
                  if (row.layer === 'l1_workspace') return true;
                  if (row.layer === 'l2_channel' && channelId && row.scopeId === channelId)
                    return true;
                  if (row.layer === 'l3_user' && userId && row.scopeId === userId) return true;
                  return false;
                })
                .map((row) => ({
                  ...row,
                  id: `eval_${row.layer}_${row.scopeId ?? 'null'}`,
                  workspaceId,
                  enabled: true,
                  updatedAt: new Date('2026-01-01T00:00:00Z'),
                }));
              return Promise.resolve(filtered);
            },
          };
        },
      };
    },
  };

  const cascade = await resolveCascade(fakeDb, { workspaceId, channelId, userId });
  return { output: JSON.stringify(cascade) };
}
