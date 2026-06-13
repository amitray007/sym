/**
 * Resolve the effective HOME persona for a turn.
 *
 * Precedence: a valid per-channel override (set via `sym persona set`) wins over
 * the deployment-global home (`SYM_PERSONA`). The result is THE active voice for
 * the turn — its full spec is injected and the model speaks as it, switching only
 * on an explicit per-reply request (handled in the prompt, not here).
 *
 * The channel lookup is fail-open: a settings-store read must never break a
 * turn, so any error falls through to the global home.
 */

import { isPersonaName, type PersonaName } from '@sym/kernel';
import { getChannelPersonaStore } from '@sym/mcp-runtime';

/** Warn at most once: a persistently broken settings store would otherwise log a
 *  line every turn. Server logs use console.warn, never console.log (ARCHITECTURE I-7). */
let _warnedStore = false;

/**
 * Read a channel's stored override, swallowing any store error (fail-open).
 * A broken/unwritable settings store disables ALL per-channel overrides, which is
 * easy to miss — so it warns once before falling through to the global home.
 */
function readChannelPersona(channelId: string): string | undefined {
  try {
    return getChannelPersonaStore().get(channelId);
  } catch (err) {
    if (!_warnedStore) {
      _warnedStore = true;
      console.warn(
        '[persona] channel persona store is unreadable; per-channel home overrides are disabled this run, falling back to the global home (SYM_PERSONA):',
        err,
      );
    }
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
