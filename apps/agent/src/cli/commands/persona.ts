/**
 * `sym persona` — inspect the voices Sym speaks in, report the deployment's home
 * voice, and manage per-channel home overrides.
 *
 * Read paths (`ls`, `show`) are pure introspection — dual-audience (the operator
 * runs it; the agent runs it via run_cli) and never touch SQLite. The channel
 * paths (`channels`, `set`, `unset`) read/write the settings store, so they
 * lazy-load it to keep the common read paths free of node:sqlite.
 *
 * The deployment HOME voice is set via the SYM_PERSONA env var (this command
 * reports it). A per-channel override (set here) wins over the global home for
 * turns in that channel; the agent reads it per turn.
 */

import {
  DEFAULT_PERSONA,
  isPersonaName,
  PERSONA_NAMES,
  PERSONAS,
  resolvePersona,
} from '@sym/kernel';

/** `sym persona [ls] | show [name] | channels | set <ch> <name> | unset <ch>` */
export async function personaCommand(args: string[], json: boolean): Promise<number> {
  const [verb, a, b] = args;
  const home = resolvePersona(process.env['SYM_PERSONA']);

  // --- channel overrides (touch the settings store; lazy-load node:sqlite) ---

  if (verb === 'set') {
    const channelId = a;
    const persona = b?.trim().toLowerCase();
    if (channelId === undefined || persona === undefined) {
      console.error('usage: sym persona set <channel-id> <persona>');
      return 1;
    }
    if (!isPersonaName(persona)) {
      console.error(`unknown persona '${b}' — try one of: ${PERSONA_NAMES.join(', ')}`);
      return 1;
    }
    const { getChannelPersonaStore } = await import('@sym/mcp-runtime');
    getChannelPersonaStore().set(channelId, persona);
    console.log(`${channelId} → ${PERSONAS[persona].label}`);
    return 0;
  }

  if (verb === 'unset') {
    const channelId = a;
    if (channelId === undefined) {
      console.error('usage: sym persona unset <channel-id>');
      return 1;
    }
    const { getChannelPersonaStore } = await import('@sym/mcp-runtime');
    const removed = getChannelPersonaStore().remove(channelId);
    console.log(removed ? `unset ${channelId}` : `no override for ${channelId}`);
    return 0;
  }

  if (verb === 'channels') {
    const { getChannelPersonaStore } = await import('@sym/mcp-runtime');
    const overrides = getChannelPersonaStore().list();
    if (json) {
      console.log(
        JSON.stringify(
          overrides.map((o) => ({
            channelId: o.channelId,
            persona: o.persona,
            label: isPersonaName(o.persona) ? PERSONAS[o.persona].label : o.persona,
          })),
        ),
      );
      return 0;
    }
    if (overrides.length === 0) {
      console.log('No per-channel overrides. Set one with: sym persona set <channel-id> <persona>');
      return 0;
    }
    console.log('Per-channel home overrides:');
    for (const o of overrides) {
      const label = isPersonaName(o.persona) ? PERSONAS[o.persona].label : `${o.persona} (unknown)`;
      console.log(`  ${o.channelId}  →  ${label}`);
    }
    return 0;
  }

  // --- voice introspection (no DB) ---

  if (verb === 'show') {
    const target = a !== undefined ? a.trim().toLowerCase() : home;
    if (!isPersonaName(target)) {
      console.error(`unknown persona '${a}' — try one of: ${PERSONA_NAMES.join(', ')}`);
      return 1;
    }
    if (json) {
      console.log(JSON.stringify({ name: target, ...PERSONAS[target], home: target === home }));
    } else {
      console.log(`${PERSONAS[target].label}${target === home ? '  (home)' : ''}`);
      console.log(`  ${PERSONAS[target].blurb}`);
    }
    return 0;
  }

  if (verb !== undefined && verb !== 'ls' && verb !== 'list') {
    console.error(
      `unknown 'sym persona ${verb}' — use: sym persona [ls] | show [name] | channels | set <ch> <name> | unset <ch>`,
    );
    return 1;
  }

  // --- the roster (default) ---

  if (json) {
    console.log(
      JSON.stringify({
        home,
        personas: PERSONA_NAMES.map((n) => ({ name: n, ...PERSONAS[n], home: n === home })),
      }),
    );
    return 0;
  }

  console.log('Personas — Sym auto-selects one per reply; home is the default/fallback voice.');
  console.log(
    `Home: ${PERSONAS[home].label}   (set via SYM_PERSONA; default ${PERSONAS[DEFAULT_PERSONA].label})\n`,
  );
  for (const n of PERSONA_NAMES) {
    const marker = n === home ? '●' : ' ';
    console.log(`${marker} ${PERSONAS[n].label.padEnd(10)} ${PERSONAS[n].blurb}`);
  }
  console.log(
    '\nPer-channel overrides: sym persona channels   (set: sym persona set <channel-id> <persona>)',
  );
  return 0;
}
