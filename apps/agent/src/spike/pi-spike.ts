/**
 * pi-spike.ts — Spike: one Pi turn against Fireworks, streaming to console.
 *
 * Goal: prove Pi can run a turn in-process against Sym's Fireworks config,
 *       using Sym's persona, with incremental streaming output.
 *
 * ADDITIVE ONLY — does not touch any existing turn loop, server, or runtime path.
 *
 * Run via:
 *   pnpm --filter @sym/agent spike:pi
 *
 * Requires .env with DATABASE_URL (+ secrets key ring for the encrypted api_key
 * column). Falls back to FIREWORKS_* env vars if the DB has no provider config.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stream } from '@earendil-works/pi-ai';
import { createDb, providerConfigs } from '@sym/db';
import { buildSystemPrompt } from '@sym/kernel';
import { initSecrets } from '@sym/secrets';
import { config as loadDotenv } from 'dotenv';
import { and, eq } from 'drizzle-orm';

import { buildFireworksModel } from '../pi/model.js';

import type { UserMessage } from '@earendil-works/pi-ai';

// ---------------------------------------------------------------------------
// Bootstrap: load .env (dev convenience — prod injects env directly)
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
loadDotenv({ path: resolve(repoRoot, '.env') });

// ---------------------------------------------------------------------------
// Resolve Fireworks credentials from DB (preferred) or env (fallback)
// ---------------------------------------------------------------------------

interface FireworksConfig {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  source: 'db' | 'env';
}

async function resolveFireworksConfig(): Promise<FireworksConfig> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl) {
    try {
      await initSecrets(); // decrypt the encryptedText api_key column
      const { db, close } = createDb(databaseUrl);

      const row = (
        await db
          .select()
          .from(providerConfigs)
          .where(and(eq(providerConfigs.provider, 'fireworks'), eq(providerConfigs.enabled, true)))
          .limit(1)
      )[0];

      await close();

      if (row) {
        return {
          baseUrl: row.baseUrl ?? 'https://api.fireworks.ai/inference/v1',
          apiKey: row.apiKey, // decrypts transparently via encryptedText
          modelId: row.modelChat,
          source: 'db',
        };
      }

      console.warn('[pi-spike] No enabled Fireworks config in DB; falling back to env vars.');
    } catch (err) {
      console.warn('[pi-spike] DB load failed; falling back to env vars:', err);
    }
  }

  // Env-var fallback
  const apiKey = process.env['FIREWORKS_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'No Fireworks config found: set DATABASE_URL (with a providerConfigs row) ' +
        'or set FIREWORKS_API_KEY + FIREWORKS_BASE_URL + FIREWORKS_MODEL.',
    );
  }

  return {
    baseUrl: process.env['FIREWORKS_BASE_URL'] ?? 'https://api.fireworks.ai/inference/v1',
    apiKey,
    modelId: process.env['FIREWORKS_MODEL'] ?? 'accounts/fireworks/models/llama-v3p1-70b-instruct',
    source: 'env',
  };
}

// ---------------------------------------------------------------------------
// Spike entry point
// ---------------------------------------------------------------------------

const TEST_PROMPT =
  'Introduce yourself in one sentence, then compute 17 × 23 and briefly show your reasoning.';

async function main(): Promise<void> {
  const fwConfig = await resolveFireworksConfig();
  console.info(`[pi-spike] config source: ${fwConfig.source}`);
  console.info(`[pi-spike] model: ${fwConfig.modelId}`);
  console.info(`[pi-spike] baseUrl: ${fwConfig.baseUrl}`);
  console.info('[pi-spike] prompt:', TEST_PROMPT);
  console.info('---');

  // Build a Pi Model object for Fireworks via the shared builder (DRY — same
  // config used by the Pi turn loop in apps/agent/src/pi/model.ts).
  const model = buildFireworksModel({ baseUrl: fwConfig.baseUrl, modelId: fwConfig.modelId });

  // Sym's full persona — imported from the kernel, not duplicated here.
  const systemPrompt = buildSystemPrompt();

  // Pi Context: system prompt + single user message (UserMessage requires timestamp).
  const userMessage: UserMessage = {
    role: 'user',
    content: TEST_PROMPT,
    timestamp: Date.now(),
  };

  const context = {
    systemPrompt,
    messages: [userMessage],
  };

  // Stream the response, printing text_delta chunks as they arrive.
  // TODO(pi): if Pi introduces a session/turn API in pi-agent-core that wraps
  // this with tool dispatch, migrate the Slack turn loop to that layer (chunk 2).
  const s = stream(model, context, { apiKey: fwConfig.apiKey });

  for await (const event of s) {
    switch (event.type) {
      case 'text_delta':
        process.stdout.write(event.delta);
        break;
      case 'done':
        process.stdout.write('\n');
        console.info('--- turn complete ---');
        break;
      case 'error':
        console.error('\n[pi-spike] stream error:', event.error);
        break;
      default:
        // Lifecycle events (start, text_start, text_end, etc.) — silently ignored
        break;
    }
  }
}

main().catch((err: unknown) => {
  console.error('[pi-spike] fatal:', err);
  process.exit(1);
});
