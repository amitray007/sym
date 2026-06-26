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
  // URL match takes precedence across ALL entries before any name match, so a
  // pasted URL can never resolve to a different repo whose name happens to
  // collide with it.
  const byUrl = allowlist.find((entry) => entry.url === trimmed);
  if (byUrl !== undefined) return byUrl;
  const lower = trimmed.toLowerCase();
  return allowlist.find((entry) => entry.name.toLowerCase() === lower) ?? null;
}
