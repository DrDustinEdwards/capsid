import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// /health AGAINST A REAL D1. The endpoint probes the store as well as reporting
// provenance: a SELECT 1 plus an FTS MATCH pinned to capsid/conventions.md, and it
// answers 503 `degraded` if either fails. Bindings resolve by name at deploy time,
// so a Worker pointed at nothing starts fine while every read tool errors; this
// endpoint makes that visible.

describe("/health", () => {
  it("is degraded on an empty store, because the FTS probe finds nothing to match", async () => {
    const response = await SELF.fetch("https://capsid.test/health");
    const body = (await response.json()) as { status: string; checks?: Record<string, unknown> };
    // The migrations ran, so D1 answers; the pinned document does not exist yet, so
    // the FTS half fails. A store that answers SELECT 1 and holds nothing is the
    // "bound to the wrong database" case.
    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
  });

  it("is ok once the pinned document exists and the FTS index has it", async () => {
    // Written through raw SQL rather than the write tool, so this tests the triggers:
    // documents_fts is external-content, and the index only has this row
    // if migrations/0001_init.sql wired its AFTER INSERT trigger correctly.
    await env.DB.prepare(
      `INSERT INTO documents (namespace, path, title, body, type, status)
       VALUES ('capsid', 'conventions.md', 'Portfolio-wide conventions', 'Standing rules that apply across all projects.', 'procedural', 'published')`
    ).run();

    const indexed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM documents_fts WHERE documents_fts MATCH 'conventions'"
    ).first<{ n: number }>();
    expect(indexed?.n).toBe(1);

    const response = await SELF.fetch("https://capsid.test/health");
    const body = (await response.json()) as { status: string; sha?: string };
    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.sha).toBe("integration");
  });

  it("reports the newest applied migration, so a half-migrated deploy is visible", async () => {
    const response = await SELF.fetch("https://capsid.test/health");
    const body = (await response.json()) as { schema_version?: string | null };
    // Derived from migrations/, not hardcoded: the newest file the setup applied is
    // what the endpoint must name, so adding a migration cannot leave this stale.
    const newest = env.TEST_MIGRATIONS.at(-1);
    expect(newest, "no migrations were handed to the setup file").toBeDefined();
    expect(body.schema_version).toBe(newest!.name);
  });
});
