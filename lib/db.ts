import postgres from "postgres";
import { z } from "zod";

// The ledger database (docs/architecture.md). DATABASE_URL holds a password, so errors never
// echo its value.
const DatabaseUrl = z.url({ protocol: /^postgres(ql)?$/ });

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const parsed = DatabaseUrl.safeParse(env.DATABASE_URL);
  if (!parsed.success) {
    throw new Error("DATABASE_URL must be a postgres:// URL. See .env.example.");
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
    // snake_case columns in SQL, camelCase fields in TypeScript.
    transform: postgres.camel,
    ...(options.schema ? { connection: { search_path: options.schema } } : {}),
  });
}
