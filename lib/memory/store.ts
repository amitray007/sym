import type { Sql } from "../db.ts";

// Plain SQL over memory_facts (migration 004). Every function takes the scope key and filters
// on it, so a caller cannot reach another scope's rows.

export interface Fact {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export const MAX_FACT_CHARS = 2000;

interface Row {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const toFact = (row: Row): Fact => ({ ...row, id: String(row.id) });

function parseId(id: string): bigint | undefined {
  return /^\d{1,18}$/.test(id) ? BigInt(id) : undefined;
}

// Saves a fact. The same text in the same scope returns the existing row, so a replayed tool
// call adds nothing.
export async function saveFact(
  sql: Sql,
  scopeKey: string,
  slot: string,
  text: string,
  metadata: Record<string, unknown> = {},
): Promise<Fact> {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("A memory needs some text.");
  if (clean.length > MAX_FACT_CHARS)
    throw new Error(`A memory holds at most ${MAX_FACT_CHARS} characters.`);
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${scopeKey}/${slot}`}, 0))`;
    const [same] = await tx<Row[]>`
      select id, text, metadata, created_at, updated_at from memory_facts
      where scope_key = ${scopeKey} and slot = ${slot} and text = ${clean} and deleted_at is null
    `;
    if (same) return toFact(same);
    const [row] = await tx<Row[]>`
      insert into memory_facts (scope_key, slot, text, metadata)
      values (${scopeKey}, ${slot}, ${clean}, ${tx.json(metadata as never)})
      returning id, text, metadata, created_at, updated_at
    `;
    if (!row) throw new Error("memory insert returned no row");
    return toFact(row);
  });
}

// Replaces the text of a live fact. Returns undefined when the id is not in this scope.
export async function updateFact(
  sql: Sql,
  scopeKey: string,
  slot: string,
  id: string,
  text: string,
): Promise<Fact | undefined> {
  const key = parseId(id);
  const clean = text.trim().replace(/\s+/g, " ");
  if (key === undefined || !clean || clean.length > MAX_FACT_CHARS) return undefined;
  const [row] = await sql<Row[]>`
    update memory_facts set text = ${clean}, updated_at = now()
    where id = ${key.toString()} and scope_key = ${scopeKey} and slot = ${slot}
      and deleted_at is null
    returning id, text, metadata, created_at, updated_at
  `;
  return row ? toFact(row) : undefined;
}

// Soft delete. Returns false when the id is not a live fact in this scope.
export async function deleteFact(
  sql: Sql,
  scopeKey: string,
  slot: string,
  id: string,
): Promise<boolean> {
  const key = parseId(id);
  if (key === undefined) return false;
  const rows = await sql`
    update memory_facts set deleted_at = now(), updated_at = now()
    where id = ${key.toString()} and scope_key = ${scopeKey} and slot = ${slot}
      and deleted_at is null
    returning id
  `;
  return rows.length > 0;
}

// Newest first.
export async function listFacts(
  sql: Sql,
  scopeKey: string,
  slot: string,
  limit: number,
): Promise<Fact[]> {
  const rows = await sql<Row[]>`
    select id, text, metadata, created_at, updated_at from memory_facts
    where scope_key = ${scopeKey} and slot = ${slot} and deleted_at is null
    order by updated_at desc, id desc limit ${limit}
  `;
  return rows.map(toFact);
}

// Word search first, then a substring match for partial words. Both stay inside the scope.
export async function searchFacts(
  sql: Sql,
  scopeKey: string,
  slot: string,
  query: string,
  limit: number,
): Promise<Fact[]> {
  const q = query.trim();
  if (!q) return listFacts(sql, scopeKey, slot, limit);
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await sql<Row[]>`
    select id, text, metadata, created_at, updated_at from memory_facts
    where scope_key = ${scopeKey} and slot = ${slot} and deleted_at is null
      and (to_tsvector('simple', text) @@ websearch_to_tsquery('simple', ${q})
        or text ilike ${like})
    order by updated_at desc, id desc limit ${limit}
  `;
  return rows.map(toFact);
}
