import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runBackup, TABLES } from "../src/backup";

// The nightly dump against a real D1, through d1-dump: only a migrated database shows what the package discovers
// (_cf_ tables, d1_migrations, documents_fts shadow tables); the run must dump exactly TABLES.

type Env = Parameters<typeof runBackup>[0];
const ENV = env as unknown as Env;

describe("the nightly dump on a migrated D1", () => {
  it("dumps exactly TABLES, writes _schema.json, and marks the run complete", async () => {
    // The document the preflight's FTS probe pins, through raw SQL so the trigger
    // indexes it.
    await env.DB.prepare(
      `INSERT INTO documents (namespace, path, title, body, type, status)
       VALUES ('capsid', 'conventions.md', 'Portfolio-wide conventions', 'Standing rules that apply across all projects.', 'procedural', 'published')`,
    ).run();

    const result = await runBackup(ENV);
    expect(result.ran).toBe(true);
    if (!result.ran) return;
    expect(result.prune_refused, "the live schema is not the one TABLES lists").toBeNull();

    const files = result.json_keys.map((k) => k.slice(result.json_prefix.length));
    expect(files.filter((f) => !f.startsWith("_")).sort()).toEqual(
      TABLES.map((t) => `${t}.json.gz`).sort(),
    );
    expect(files.filter((f) => f.startsWith("_")).sort()).toEqual([
      "_complete.json",
      "_kv.json",
      "_schema.json",
    ]);
    expect(files.at(-1)).toBe("_complete.json");

    const schema = JSON.parse(
      await (await env.MEDIA.get(`${result.json_prefix}_schema.json`))!.text(),
    ) as {
      schema: Array<{ type: string; name: string }>;
    };
    const tables = schema.schema.filter((e) => e.type === "table").map((e) => e.name);
    for (const t of TABLES) expect(tables).toContain(t);
    expect(tables).toContain("documents_fts");
    expect(
      tables.filter((t) => t.startsWith("documents_fts_")),
      "a shadow table reached the schema",
    ).toEqual([]);
    expect(
      tables.filter((t) => t.startsWith("_cf_") || t.startsWith("sqlite_")),
      "an internal table reached the schema",
    ).toEqual([]);
  });
});
