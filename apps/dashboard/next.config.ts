import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { NextConfig } from 'next';

// Load the monorepo-root .env so the dashboard reads the SAME config as the rest
// of the stack (the agent loads it via dotenv). Next only auto-loads .env from
// the app directory; here the single source of truth is the repo-root .env.
// In production (Dokploy) there is no file and real env vars are injected — the
// existsSync guard makes this a no-op there.
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

const nextConfig: NextConfig = {
  // Skip the pages-router static 404/500 prerendering — we use App Router only.
  // This avoids the "<Html> outside _document" error in Next 15.
  skipTrailingSlashRedirect: false,
};

export default nextConfig;
