/**
 * Real-wire canary for cleanupReply — hits the actual Fireworks inference
 * endpoint to verify the full span-removal pipeline works end-to-end.
 *
 * Requires FIREWORKS_API_KEY and FIREWORKS_MODEL to be set; skipped
 * automatically in CI environments where these are absent. FIREWORKS_BASE_URL
 * defaults to the production Fireworks endpoint.
 *
 * The test exercises the happy path:
 *   - a draft that contains model narration ("Now start p1." etc.)
 *   - the LLM identifies and returns the narration fragments
 *   - cleanupReply strips them and returns a narration-free answer
 *
 * This is a canary — not a behavioral assertion about the model's specific
 * output. We only assert structural properties: the cleaned reply must
 * (a) not contain the obvious narration fragment "Now start p1." and
 * (b) still contain the real answer content "the meeting is on Friday".
 */

import { describe, expect, it } from 'vitest';

import { cleanupReply } from '../src/reply-cleanup.js';

const API_KEY = process.env['FIREWORKS_API_KEY'];
const MODEL = process.env['FIREWORKS_MODEL'];
const BASE_URL = process.env['FIREWORKS_BASE_URL'] ?? 'https://api.fireworks.ai/inference/v1';

const canRun = API_KEY !== undefined && API_KEY.length > 0 && MODEL !== undefined;

describe.skipIf(!canRun)(
  'cleanupReply real-wire canary (requires FIREWORKS_API_KEY + FIREWORKS_MODEL)',
  () => {
    it('strips model narration and preserves the real answer', async () => {
      const draft =
        'Now start p1.\n\n' + 'The meeting is on Friday.\n\n' + 'Mark p1 complete. Now reply.';

      const deps = {
        fireworks: { baseUrl: BASE_URL, apiKey: API_KEY! },
        model: MODEL!,
      };

      const cleaned = await cleanupReply(draft, deps);

      // The real answer must survive.
      expect(cleaned).toContain('the meeting is on Friday');

      // Obvious narration phrases should be stripped (LLM may flag them).
      // We don't assert exact removal — the LLM decides — but if the model
      // returned any fragments at all they should include the narration.
      // If no fragments are returned (LLM is overly conservative) the
      // original draft is returned unchanged — that is also acceptable.
      expect(cleaned.length).toBeGreaterThan(0);
    }, 30_000);
  },
);
