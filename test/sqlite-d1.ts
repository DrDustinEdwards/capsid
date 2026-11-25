import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

/** An in-memory SQLite database with every migration applied. */
export function migratedDb(): DatabaseSync {
  const raw = new DatabaseSync(":memory:");
  for (const name of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    raw.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  return raw;
}

/** The slice of D1 the readers and writers call (prepare, bind, first, all, run, batch) over Node's SQLite. */
export function d1(db: DatabaseSync): D1Database {
  const statement = (sql: string, params: unknown[] = []) => {
    const s = db.prepare(sql);
    const args = params as Array<string | number | null>;
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      first: async () => (s.get(...args) as Record<string, unknown> | undefined) ?? null,
      all: async () => ({ results: s.all(...args).map((r) => ({ ...r })) }),
      run: async () => ({ meta: { changes: Number(s.run(...args).changes) } }),
      exec: () =>
        /\bRETURNING\b|^\s*SELECT/i.test(sql)
          ? { results: s.all(...args) }
          : { results: [], meta: { changes: Number(s.run(...args).changes) } },
    };
  };
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (list: Array<{ exec: () => unknown }>) => {
      db.exec("BEGIN");
      try {
        const out = list.map((st) => st.exec());
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  } as unknown as D1Database;
}
