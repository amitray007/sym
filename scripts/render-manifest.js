#!/usr/bin/env node
// Renders slack/manifest.template.yml → slack/manifest.yml by substituting
// ${SLACK_PUBLIC_BASE_URL} from the environment.
import { readFileSync, writeFileSync } from 'node:fs';

const url = (process.env.SLACK_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
if (!url) {
  console.error('Error: SLACK_PUBLIC_BASE_URL is not set');
  process.exit(1);
}

const template = readFileSync('slack/manifest.template.yml', 'utf8');
const rendered = template.replaceAll('${SLACK_PUBLIC_BASE_URL}', url);
writeFileSync('slack/manifest.yml', rendered);
console.log(`wrote slack/manifest.yml (base URL: ${url})`);
