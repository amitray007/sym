import postgres from "postgres";
import { z } from "zod";

// The ledger database (docs/architecture.md). DATABASE_URL holds a password, so errors never
// echo its value.
const DatabaseUrl = z.url({ protocol: /^postgres(ql)?$/ });

// An eval run uses its own database (decision 064). `eve eval` sets EVE_EVALUATION, and the eval
// setup sets SYM_EVAL_DATABASE_URL. Eve reloads the .env files when it starts the agent server,
// which can put the owner's DATABASE_URL back, so an eval run reads only the eval URL and never
// falls back to DATABASE_URL.
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.EVE_EVALUATION === "1" ? "SYM_EVAL_DATABASE_URL" : "DATABASE_URL";
  const parsed = DatabaseUrl.safeParse(env[name]);
  if (!parsed.success) {
    throw new Error(`${name} must be a postgres:// URL. See .env.example.`);
  }
  return parsed.data;
}

export type Sql = postgres.Sql;

export interface ConnectOptions {
  url?: string;
  // A schema to use instead of `public`. Tests give each file its own schema.
  schema?: string;
}

export function connect(options: ConnectOptions = {}): Sql {
  return postgres(options.url ?? databaseUrl(), {
    // One replica runs Sym (docs/self-hosting.md), so a small pool is enough.
    max: 5,
    onnotice: () => {},
    // snake_case columns in SQL, camelCase fields in TypeScript. Column names only: the value
    // transform would also rename keys inside JSON values, such as a Slack payload's thread_ts.
    transform: { column: postgres.camel.column },
    ...(options.schema ? { connection: { search_path: options.schema } } : {}),
  });
}
