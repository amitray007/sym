import { activeConnections } from "../lib/connections/rows.ts";
import { connect } from "../lib/db.ts";
import { migrate } from "../lib/ledger/migrate.ts";

// The eval database (decision 064). Not an eval file. Evals never use the owner's database: an
// approved connection there would let the brain reach a live server. Setup points DATABASE_URL at
// SYM_EVAL_DATABASE_URL, creates that database when it is missing, applies the migrations, and
// stops when a connection is active. The URL holds a password, so no message echoes it.

const LOCAL = "postgres://sym:sym@localhost:55432/sym_eval";
const MISSING_DATABASE = "3D000";

export async function prepareEvalDatabase(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const url = env.SYM_EVAL_DATABASE_URL?.trim() || LOCAL;
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error("SYM_EVAL_DATABASE_URL must name a database such as sym_eval.");
  }

  try {
    await migrated(url);
  } catch (error) {
    if ((error as { code?: string }).code !== MISSING_DATABASE) throw error;
    const server = new URL(url);
    server.pathname = "/postgres";
    const admin = connect({ url: server.href });
    try {
      await admin.unsafe(`create database "${name}"`);
    } finally {
      await admin.end();
    }
    await migrated(url);
  }

  // No log line: `eve eval --json` prints its report on stdout.
  env.DATABASE_URL = url;
}

async function migrated(url: string): Promise<void> {
  const sql = connect({ url });
  try {
    await migrate(sql);
    const active = await activeConnections(sql);
    if (active.length > 0) {
      throw new Error(
        `The eval database has ${active.length} active connection(s). Evals need a database ` +
          "with none, so set SYM_EVAL_DATABASE_URL to another database.",
      );
    }
  } finally {
    await sql.end();
  }
}
