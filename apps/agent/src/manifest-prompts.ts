/**
 * Manifest-prompts loader — reads the Slack `manifest.yml` (or its template)
 * at boot and returns the `suggested_prompts` array for the assistant panel.
 *
 * Keeps the runtime prompt list in sync with the install-time manifest so
 * there is a single source of truth for what Sym shows users when they open
 * a fresh assistant thread.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import type { SuggestedPrompt } from '@sym/adapter-slack';

// ---------------------------------------------------------------------------
// Single source of truth for assistant-panel suggested prompts.
//
// The Slack manifest (`slack/manifest.template.yml`) declares the install-time
// `features.assistant_view.suggested_prompts` array. We also push the same
// prompts at runtime via `assistant.threads.setSuggestedPrompts` whenever a
// fresh assistant thread opens. Rather than maintain a duplicate list in
// code, we read the manifest at boot and reuse its values.
//
// Read order:
//  1. `slack/manifest.yml` (rendered output of `pnpm manifest:render`)
//  2. `slack/manifest.template.yml` (source — used in dev when render hasn't run)
//
// The prompt fields don't reference any env placeholders, so reading the
// template directly is safe. If neither file is readable, we fall back to
// a single conservative default rather than crash on boot.
// ---------------------------------------------------------------------------

const FALLBACK_PROMPTS: SuggestedPrompt[] = [
  { title: 'What can you do?', message: 'What can you help me with?' },
];

/** Repo root inferred from this module's URL (`apps/agent/src/manifest-prompts.ts`). */
function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}

/** Shape of the bit of the manifest we care about — everything else is ignored. */
interface ManifestSubset {
  features?: {
    assistant_view?: {
      suggested_prompts?: { title?: unknown; message?: unknown }[];
    };
  };
}

/** Try to read + YAML-parse a manifest file. Returns `null` on any failure. */
function tryLoad(path: string): ManifestSubset | null {
  try {
    const raw = readFileSync(path, 'utf8');
    return parseYaml(raw) as ManifestSubset;
  } catch {
    return null;
  }
}

/**
 * Extract a typed `SuggestedPrompt[]` from a parsed manifest. Filters out any
 * entries missing `title` or `message` so a half-edited manifest can't crash
 * the agent at the first assistant_thread_started event.
 */
function extractPrompts(manifest: ManifestSubset): SuggestedPrompt[] {
  const raw = manifest.features?.assistant_view?.suggested_prompts ?? [];
  const prompts: SuggestedPrompt[] = [];
  for (const p of raw) {
    if (typeof p?.title === 'string' && typeof p?.message === 'string') {
      prompts.push({ title: p.title, message: p.message });
    }
  }
  return prompts;
}

/**
 * Memoised load — first call parses the manifest, subsequent calls return the
 * cached result. Boot-time loading would also work, but lazy keeps this
 * module independent of server.ts startup ordering.
 */
let cached: SuggestedPrompt[] | undefined;

export function loadStarterPrompts(): SuggestedPrompt[] {
  if (cached !== undefined) return cached;
  const root = repoRoot();
  const manifest =
    tryLoad(resolve(root, 'slack/manifest.yml')) ??
    tryLoad(resolve(root, 'slack/manifest.template.yml'));
  if (manifest === null) {
    console.warn(
      '[agent] could not read slack/manifest.yml or slack/manifest.template.yml — falling back to default starter prompts',
    );
    cached = FALLBACK_PROMPTS;
    return cached;
  }
  const prompts = extractPrompts(manifest);
  cached = prompts.length > 0 ? prompts : FALLBACK_PROMPTS;
  return cached;
}

/** Test-only: clear the memo so a re-load picks up file changes. */
export function _resetStarterPromptsForTests(): void {
  cached = undefined;
}
