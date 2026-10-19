// Milestone 1 step 2: reach the worker over the private network, then list its projects and
// capabilities. Run `pnpm t3:check`. It reads T3_MCP_URL and T3_TOKEN from the environment or
// `.env.local`, and never prints the token.
import { t3Adapter } from "../lib/workers/t3/adapter.ts";
import { connectT3 } from "../lib/workers/t3/client.ts";

const url = process.env.T3_MCP_URL;
const token = process.env.T3_TOKEN;
if (!url || !token) {
  console.error("Set T3_MCP_URL and T3_TOKEN. See .env.example.");
  process.exit(1);
}

const connection = await connectT3({ url, getToken: async () => token });
try {
  const worker = t3Adapter(connection.call);
  const [capabilities, projects] = await Promise.all([worker.capabilities(), worker.projects()]);

  console.info(`Worker: ${new URL(url).host}`);
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
