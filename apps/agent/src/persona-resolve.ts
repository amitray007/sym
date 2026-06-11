/**
 * Resolve the effective HOME persona for a turn.
 *
 * Precedence: a valid per-channel override (set via `sym persona set`) wins over
 * the deployment-global home (`SYM_PERSONA`). The model still auto-selects a
 * voice per reply — this only changes the home/fallback the others defer to.
 *
 * The channel lookup is fail-open: a settings-store read must never break a
 * turn, so any error falls through to the global home.
 */

import { isPersonaName, type PersonaName } from '@sym/kernel';
import { getChannelPersonaStore } from '@sym/mcp-runtime';

/** Read a channel's stored override, swallowing any store error (fail-open). */
function readChannelPersona(channelId: string): string | undefined {
  try {
    return getChannelPersonaStore().get(channelId);
  } catch {
    return undefined;
  }
}

/**
 * The effective home voice: a valid per-channel override, else the global home.
 * `lookup` is injectable so callers/tests can supply the channel→persona source
 * without touching SQLite; it defaults to the real settings store.
 */
export function effectiveHomePersona(
  channelId: string | undefined,
  globalHome: PersonaName | undefined,
  lookup: (channelId: string) => string | undefined = readChannelPersona,
): PersonaName | undefined {
  if (channelId !== undefined) {
    const raw = lookup(channelId);
    // A stale/invalid stored value (e.g. a voice later removed) falls back to
    // the global home rather than erroring.
    if (raw !== undefined && isPersonaName(raw)) return raw;
  }
  return globalHome;
}
