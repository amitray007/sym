import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import { config as loadDotenv } from 'dotenv';

import { loadAgentConfig } from './config.js';
import { createServer } from './server.js';

function main(): void {
  // Dev convenience: load the repo-root .env. Production injects env directly.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  loadDotenv({ path: resolve(repoRoot, '.env') });

  const config = loadAgentConfig();
  const app = createServer({ config });
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.info(`[agent] listening on :${info.port}`);
  });
}

try {
  main();
} catch (err: unknown) {
  console.error('[agent] fatal startup error:', err);
  process.exit(1);
}
