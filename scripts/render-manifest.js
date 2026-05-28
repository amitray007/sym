#!/usr/bin/env node
// Renders slack/manifest.template.yml → slack/manifest.yml by substituting
// ${SLACK_PUBLIC_BASE_URL} from the environment.
//
// Loads the repo-root `.env` first so `pnpm manifest:render` works without
// having to inline `SLACK_PUBLIC_BASE_URL=… pnpm manifest:render` every time.
// Existing process env wins (set explicitly on the command line, you mean it).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env');
  } catch (err) {
    console.warn(`Warning: failed to load .env (${err.message ?? err}); using process env only`);
  }
}

const url = (process.env.SLACK_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
if (!url) {
  console.error('Error: SLACK_PUBLIC_BASE_URL is not set');
  process.exit(1);
}

const template = readFileSync('slack/manifest.template.yml', 'utf8');
const rendered = template.replaceAll('${SLACK_PUBLIC_BASE_URL}', url);
writeFileSync('slack/manifest.yml', rendered);
console.log(`wrote slack/manifest.yml (base URL: ${url})`);
