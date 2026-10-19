// Applies pending ledger migrations. Run `pnpm db:migrate` before `eve start`.
import { connect } from "../lib/db.ts";
import { migrate } from "../lib/ledger/migrate.ts";

const sql = connect();
try {
  const applied = await migrate(sql);
  console.info(applied.length ? `Applied: ${applied.join(", ")}` : "The ledger is up to date.");
} finally {
  await sql.end();
}
