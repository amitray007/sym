/**
 * `sym secret set|ls|rm` — manage encrypted secrets (never printed).
 *
 * Values are read from stdin only — never accepted as a positional arg, which
 * would leak them via the process table (`ps`, /proc/<pid>/cmdline).
 */

/** Read all of stdin as a trimmed string (for piping secret values). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

export async function secretCommand(args: string[], json: boolean): Promise<number> {
  const verb = args[0];
  // Lazy import: only `sym secret` needs the SQLite-backed store, so non-secret
  // verbs don't load node:sqlite (avoids its experimental warning + the open).
  const { listSecrets, removeSecret, setSecret } = await import('../secrets.js');

  if (verb === 'set') {
    const connector = args[1];
    const field = args[2];
    if (connector === undefined || field === undefined) {
      throw new Error('secret set requires <connector> <field> (value is read from stdin)');
    }
    // SECURITY (Z09-14): never accept the secret as a positional arg — it would be
    // visible in the process table (`ps`, /proc/<pid>/cmdline) to any local user.
    // The value is read from stdin only.
    if (args[3] !== undefined) {
      throw new Error(
        'secret set does not accept the value as an argument (it leaks via the process ' +
          `table). Pipe it via stdin: \`printf %s "$TOKEN" | sym secret set ${connector} ${field}\``,
      );
    }
    const value = await readStdin();
    if (value.length === 0) {
      throw new Error(
        'no secret value provided — pipe it via stdin: ' +
          `\`printf %s "$TOKEN" | sym secret set ${connector} ${field}\``,
      );
    }
    setSecret(connector, field, value);
    console.log(`stored secret ${connector}/${field}`);
    return 0;
  }

  if (verb === 'ls' || verb === 'list') {
    const refs = listSecrets();
    if (json) {
      console.log(JSON.stringify({ secrets: refs }, null, 2));
      return 0;
    }
    if (refs.length === 0) {
      console.log('(no secrets stored)');
      return 0;
    }
    for (const r of refs) console.log(`  ${r.connector}/${r.field}`);
    return 0;
  }

  if (verb === 'rm' || verb === 'remove') {
    const connector = args[1];
    const field = args[2];
    if (connector === undefined || field === undefined) {
      throw new Error('secret rm requires <connector> <field>');
    }
    removeSecret(connector, field);
    console.log(`removed secret ${connector}/${field}`);
    return 0;
  }

  throw new Error(`unknown 'secret' verb '${verb ?? ''}' — see 'sym help'`);
}
