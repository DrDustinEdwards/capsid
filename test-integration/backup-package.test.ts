import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runBackup, TABLES } from "../src/backup";

// THE NIGHTLY DUMP AGAINST A REAL D1, through @dustinedwards/d1-dump.
//
// The unit tests drive a fake whose sqlite_master is written by hand. Only a real
// database, migrated the way production is, shows what the package discovers:
// D1's own _cf_ tables, wrangler's d1_migrations ledger, documents_fts and its shadow
// tables. The run must dump exactly TABLES, or it is refused as tables-mismatch.

type Env = Parameters<typeof runBackup>[0];
const ENV = env as unknown as Env;

describe("the nightly dump on a migrated D1", () => {
  it("dumps exactly TABLES, writes _schema.json, and marks the run complete", async () => {
    // The document the preflight's FTS probe pins, through raw SQL so the trigger
    // indexes it.
    await env.DB.prepare(
      `INSERT INTO documents (namespace, path, title, body, type, status)
       VALUES ('capsid', 'conventions.md', 'Portfolio-wide conventions', 'Standing rules that apply across all projects.', 'procedural', 'published')`
    ).run();

    const result = await runBackup(ENV);
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.prune_refused, "the live schema is not the one TABLES lists").toBeNull();

    const files = result.json_keys.map((k) => k.slice(result.json_prefix.length));
    expect(files.filter((f) => !f.startsWith("_")).sort()).toEqual(TABLES.map((t) => `${t}.json`).sort());
    expect(files.filter((f) => f.startsWith("_")).sort()).toEqual(["_complete.json", "_holdout-manifests.json", "_kv.json", "_schema.json"]);
    expect(files.at(-1)).toBe("_complete.json");

    const schema = JSON.parse(await (await env.MEDIA.get(`${result.json_prefix}_schema.json`))!.text()) as {
      schema: Array<{ type: string; name: string }>;
    };
    const tables = schema.schema.filter((e) => e.type === "table").map((e) => e.name);
    for (const t of TABLES) expect(tables).toContain(t);
    expect(tables).toContain("documents_fts");
    expect(tables.filter((t) => t.startsWith("documents_fts_")), "a shadow table reached the schema").toEqual([]);
    expect(tables.filter((t) => t.startsWith("_cf_") || t.startsWith("sqlite_")), "an internal table reached the schema").toEqual([]);
  });
});
