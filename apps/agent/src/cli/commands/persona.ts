/**
 * `sym persona` — inspect the voices Sym speaks in, customize their specs, report
 * the deployment's home voice, and manage per-channel home overrides.
 *
 * Read paths (`ls`, `show`) are pure introspection — dual-audience (the operator
 * runs it; the agent runs it via run_cli). `edit`/`reset` manage the editable
 * `.sym/personas/<id>.md` spec overrides. The channel paths (`channels`, `set`,
 * `unset`) read/write the settings store, lazy-loaded to keep reads off sqlite.
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

import {
  isPersonaCustomized,
  loadPersonaSpec,
  personaSpecPath,
  resetPersonaSpec,
  seedPersonaSpec,
} from '../../persona-spec-loader.js';

/**
 * `sym persona [ls] | show <name> | edit <name> | reset <name> | channels |
 *  set <ch> <name> | unset <ch>`
 */
export async function personaCommand(args: string[], json: boolean): Promise<number> {
  const [verb, a, b] = args;
  const home = resolvePersona(process.env['SYM_PERSONA']);

  // --- channel overrides (touch the settings store; lazy-load node:sqlite) ---

  if (verb === 'set') {
    const channelId = a?.trim();
    const persona = b?.trim().toLowerCase();
    if (channelId === undefined || channelId.length === 0 || persona === undefined) {
      throw new Error('persona set requires <channel-id> <persona>');
    }
    if (!isPersonaName(persona)) {
      throw new Error(`unknown persona '${b}' — try one of: ${PERSONA_NAMES.join(', ')}`);
    }
    // Stored verbatim and matched by EXACT equality against the channel id Sym
    // sees at runtime — a malformed id silently never fires. We can't know the
    // real id here, so warn (never block) when it doesn't look like a Slack id.
    if (!/^[CDG][A-Z0-9]{6,}$/.test(channelId)) {
      console.warn(
        `warning: '${channelId}' doesn't look like a Slack channel/DM id (e.g. C0A1B2C3D4) — storing it anyway, but the override only applies if it exactly matches the id Sym sees at runtime.`,
      );
    }
    const { getChannelPersonaStore } = await import('@sym/mcp-runtime');
    getChannelPersonaStore().set(channelId, persona);
    if (json) {
      console.log(JSON.stringify({ channelId, persona, label: PERSONAS[persona].label }));
      return 0;
    }
    console.log(`${channelId} → ${PERSONAS[persona].label}`);
    return 0;
  }

  if (verb === 'unset') {
    const channelId = a?.trim();
    if (channelId === undefined || channelId.length === 0) {
      throw new Error('persona unset requires <channel-id>');
    }
    const { getChannelPersonaStore } = await import('@sym/mcp-runtime');
    const removed = getChannelPersonaStore().remove(channelId);
    if (json) {
      console.log(JSON.stringify({ channelId, removed }));
      return 0;
    }
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

  // --- editable spec overrides (.sym/personas/<id>.md) ---

  if (verb === 'edit' || verb === 'reset') {
    const name = a?.trim().toLowerCase();
    if (name === undefined || !isPersonaName(name)) {
      throw new Error(`persona ${verb} requires a voice: ${PERSONA_NAMES.join(', ')}`);
    }

    if (verb === 'reset') {
      const removed = resetPersonaSpec(name);
      if (json) {
        console.log(JSON.stringify({ persona: name, label: PERSONAS[name].label, reset: removed }));
        return 0;
      }
      console.log(
        removed
          ? `reset ${PERSONAS[name].label} to its default spec`
          : `${PERSONAS[name].label} already uses the default spec`,
      );
      return 0;
    }

    // edit: TTY-only — opening $EDITOR needs a terminal. Off-TTY (the agent via
    // run_cli, CI, a pipe) we write nothing and just point at the path to edit.
    if (!process.stdout.isTTY) {
      console.error(
        `'sym persona edit' needs an interactive terminal. Edit the file directly:\n  ${personaSpecPath(name)}`,
      );
      return 1;
    }
    const path = seedPersonaSpec(name); // seed a copy of the default to edit from
    const editor = process.env['VISUAL'] ?? process.env['EDITOR'] ?? 'vi';
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(editor, [path], { stdio: 'inherit' });
    if (res.error !== undefined) {
      console.error(`could not launch ${editor}: ${res.error.message}. Edit directly:\n  ${path}`);
      return 1;
    }
    if (res.status === 0) console.log(`saved ${PERSONAS[name].label} → ${path}`);
    return res.status ?? 0;
  }

  // --- voice introspection (no DB) ---

  if (verb === 'show') {
    const target = a !== undefined ? a.trim().toLowerCase() : home;
    if (!isPersonaName(target)) {
      throw new Error(`unknown persona '${a}' — try one of: ${PERSONA_NAMES.join(', ')}`);
    }
    const customized = isPersonaCustomized(target);
    if (json) {
      console.log(
        JSON.stringify({
          name: target,
          ...PERSONAS[target],
          home: target === home,
          customized,
          specPath: personaSpecPath(target),
          spec: loadPersonaSpec(target),
        }),
      );
      return 0;
    }
    const tags = [target === home ? 'home' : '', customized ? 'customized' : '']
      .filter((t) => t.length > 0)
      .join(', ');
    console.log(`${PERSONAS[target].label}${tags.length > 0 ? `  (${tags})` : ''}`);
    console.log(`  ${PERSONAS[target].blurb}`);
    console.log(
      `  spec: ${personaSpecPath(target)}${customized ? '' : `  (default — \`sym persona edit ${target}\` to customize)`}`,
    );
    console.log('');
    console.log(loadPersonaSpec(target));
    return 0;
  }

  if (verb !== undefined && verb !== 'ls' && verb !== 'list') {
    throw new Error(
      `unknown 'persona' verb '${verb}' — use: sym persona [ls] | show <name> | edit <name> | ` +
        `reset <name> | channels | set <ch> <name> | unset <ch>`,
    );
  }

  // --- the roster (default) ---

  if (json) {
    console.log(
      JSON.stringify({
        home,
        personas: PERSONA_NAMES.map((n) => ({
          name: n,
          ...PERSONAS[n],
          home: n === home,
          customized: isPersonaCustomized(n),
        })),
      }),
    );
    return 0;
  }

  console.log(
    'Personas — one active voice per turn: the channel/deployment home, or an explicit ask.',
  );
  console.log(
    `Home: ${PERSONAS[home].label}   (set via SYM_PERSONA; default ${PERSONAS[DEFAULT_PERSONA].label})\n`,
  );
  for (const n of PERSONA_NAMES) {
    const marker = n === home ? '●' : ' ';
    const star = isPersonaCustomized(n) ? ' *' : '';
    console.log(`${marker} ${PERSONAS[n].label.padEnd(10)} ${PERSONAS[n].blurb}${star}`);
  }
  console.log(
    '\nCustomize a voice: sym persona show <name> · edit <name> · reset <name>   (* = customized)',
  );
  console.log(
    'Per-channel home:  sym persona channels · set <channel-id> <persona> · unset <channel-id>',
  );
  return 0;
}
