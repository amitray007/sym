/**
 * `sym persona` — list the voices Sym can speak in and report the deployment's
 * home voice. Read-only introspection (dual-audience: the operator runs it, and
 * the agent can run it via run_cli to see its own roster).
 *
 * The HOME voice is set per deployment via the SYM_PERSONA env var; this command
 * REPORTS it but does not change it — that's a boot/env concern, not runtime
 * state. Mirrors the other read commands: dense output, `--json` for exact data.
 */

import {
  DEFAULT_PERSONA,
  isPersonaName,
  PERSONA_NAMES,
  PERSONAS,
  resolvePersona,
} from '@sym/kernel';

/** `sym persona [ls|list] | show [name]` — see the module docstring. */
export function personaCommand(args: string[], json: boolean): number {
  const [verb, name] = args;
  const home = resolvePersona(process.env['SYM_PERSONA']);

  // `sym persona show [name]` — one voice (defaults to the home voice).
  if (verb === 'show') {
    const target = name !== undefined ? name.trim().toLowerCase() : home;
    if (!isPersonaName(target)) {
      console.error(`unknown persona '${name}' — try one of: ${PERSONA_NAMES.join(', ')}`);
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

  // `sym persona` / `sym persona ls` / `sym persona list` — the full roster.
  if (verb !== undefined && verb !== 'ls' && verb !== 'list') {
    console.error(`unknown 'sym persona ${verb}' — use: sym persona [ls] | show [name]`);
    return 1;
  }

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
  return 0;
}
