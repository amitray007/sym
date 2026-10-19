// Milestone 1 step 2: reach the worker over the private network, then list its projects and
// capabilities. Run `pnpm t3:check`. It finds the worker like Sym does (decision 036): the
// sign-in stored in Postgres when DATABASE_URL is set, then the pack worker or T3_MCP_URL with
// T3_TOKEN, from the environment or `.env.local`. It never prints the token.
import { connect } from "../lib/db.ts";
import { packFromEnv } from "../lib/pack/load.ts";
import { getCredential } from "../lib/workers/credentials.ts";
import { resolveWorker } from "../lib/workers/resolve.ts";
import { t3Adapter } from "../lib/workers/t3/adapter.ts";
import { connectT3 } from "../lib/workers/t3/client.ts";

const sql = process.env.DATABASE_URL ? connect() : undefined;
const resolved = await resolveWorker(packFromEnv(), process.env, async (name) =>
  sql ? getCredential(sql, name) : undefined,
).finally(() => sql?.end());
if (!resolved) {
  console.error("No worker sign-in. Ask Sym to sign in, or set T3_MCP_URL and T3_TOKEN.");
  process.exit(1);
}
const { url, token } = resolved;

const connection = await connectT3({ url, getToken: async () => token });
try {
  const worker = t3Adapter(connection.call);
  const [capabilities, projects] = await Promise.all([worker.capabilities(), worker.projects()]);

  console.info(`Worker: ${new URL(url).host} (${resolved.name}, ${resolved.source} sign-in)`);
  console.info(`Projects (${projects.length}):`);
  for (const project of projects) console.info(`  ${project.title}  ${project.id}`);
  console.info("Providers:");
  for (const provider of capabilities.providers) {
    const state = provider.available ? `${provider.models.length} models` : "unavailable";
    console.info(`  ${provider.name} (${provider.id}): ${state}`);
  }
} finally {
  await connection.close();
}
