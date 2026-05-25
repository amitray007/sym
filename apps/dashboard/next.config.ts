import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { NextConfig } from 'next';

// Load the monorepo-root .env so the dashboard reads the SAME config as the rest
// of the stack (the agent loads it via dotenv). Next only auto-loads .env from
// the app directory; here the single source of truth is the repo-root .env.
//
// We OVERRIDE existing process.env entries on purpose: in local dev the .env
// file is authoritative, so a stale or EMPTY variable exported elsewhere in the
// shell can't shadow it. (Node's process.loadEnvFile / --env-file do NOT
// override, which silently left AGENT_URL empty and hid the install button.)
// In production (Dokploy) there is no file and real env vars are injected, so
// the existsSync guard makes this a no-op there.
const rootEnv = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnv)) {
  for (const raw of readFileSync(rootEnv, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    // NODE_ENV is controlled by the build/run command (next build = production),
    // never by .env — overriding it breaks the production build.
    if (key === 'NODE_ENV') continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

const nextConfig: NextConfig = {
  // Skip the pages-router static 404/500 prerendering — we use App Router only.
  // This avoids the "<Html> outside _document" error in Next 15.
  skipTrailingSlashRedirect: false,
};

export default nextConfig;
