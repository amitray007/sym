/**
 * Repo allowlist resolution. The allowlist is the boundary on *which* repos a
 * cloud agent may touch (R3); the dispatch tool rejects anything `resolveRepo`
 * can't match. Matching is deliberately simple and explicit: a case-insensitive
 * name match or an exact URL match — nothing fuzzy.
 */

import type { RepoAllowlist, RepoRef } from './types.js';

/** Resolve a user/model-supplied repo reference against the allowlist, or null. */
export function resolveRepo(query: string, allowlist: RepoAllowlist): RepoRef | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();
  for (const entry of allowlist) {
    if (entry.url === trimmed) return entry;
    if (entry.name.toLowerCase() === lower) return entry;
  }
  return null;
}
