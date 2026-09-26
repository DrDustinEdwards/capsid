import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { IMPROVE_ACTOR, improveDocStatements } from "../src/improve-state";

// The improve and job mirror writer snapshots the live row, not the body its caller
// pre-read. The job claim path waits on GitHub between that read and the batch, so a
// write landing in the gap must still be snapshotted (hard rule 5).
//
// Here rather than in test/ because the snapshot is an INSERT ... SELECT from the live
// row, and the node fake does not evaluate that SQL.

const NS = "sample";

async function versionsOf(path: string): Promise<Array<string | null>> {
  const { results } = await env.DB.prepare(
    "SELECT body FROM document_versions WHERE namespace = ?1 AND path = ?2 ORDER BY id"
  )
    .bind(NS, path)
    .all<{ body: string | null }>();
  return results.map((r) => r.body);
}

describe("improveDocStatements snapshots the row the table holds at commit", () => {
  it("snapshots a body written after the caller's pre-read", async () => {
    const path = "jobs/lorem-1.md";
    await env.DB.prepare("INSERT INTO documents (namespace, path, title, body) VALUES (?1, ?2, 'Job', 'lorem read body')")
      .bind(NS, path)
      .run();
    const prior = await env.DB.prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
      .bind(NS, path)
      .first<{ id: number; title: string | null; body: string | null }>();
    // A write lands between the pre-read and the batch.
    await env.DB.prepare("UPDATE documents SET body = 'lorem edited in the gap' WHERE namespace = ?1 AND path = ?2")
      .bind(NS, path)
      .run();

    await env.DB.batch(
      await improveDocStatements(env.DB, {
        namespace: NS,
        path,
        title: "Job",
        body: "lorem mirror body",
        type: "task",
        prior,
        action: "job-mirror",
      })
    );

    expect(await versionsOf(path)).toEqual(["lorem edited in the gap"]);
  });

  it("snapshots a row created after a pre-read that found none", async () => {
    const path = "jobs/lorem-2.md";
    await env.DB.prepare("INSERT INTO documents (namespace, path, title, body) VALUES (?1, ?2, 'Job', 'lorem created in the gap')")
      .bind(NS, path)
      .run();

    await env.DB.batch(
      await improveDocStatements(env.DB, {
        namespace: NS,
        path,
        title: "Job",
        body: "lorem mirror body",
        type: "task",
        prior: null,
        action: "job-mirror",
      })
    );

    expect(await versionsOf(path)).toEqual(["lorem created in the gap"]);
  });

  it("writes no snapshot when there is no row", async () => {
    const path = "jobs/lorem-3.md";
    await env.DB.batch(
      await improveDocStatements(env.DB, {
        namespace: NS,
        path,
        title: "Job",
        body: "lorem mirror body",
        type: "task",
        prior: null,
        action: "job-mirror",
      })
    );
    expect(await versionsOf(path)).toEqual([]);
  });
});

// The rest of rule 5 on this path, read back from the rows.
//
// The wide dashes are built from code points, never written as literals:
// capsid/conventions.md bans the characters from source.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const HORIZONTAL_BAR = String.fromCharCode(0x2015);
const WIDE_DASH = new RegExp(`[${EN_DASH}${EM_DASH}${HORIZONTAL_BAR}]`);

async function docOf(path: string) {
  return env.DB.prepare("SELECT title, body FROM documents WHERE namespace = ?1 AND path = ?2")
    .bind(NS, path)
    .first<{ title: string; body: string }>();
}

async function auditsOf(path: string) {
  const { results } = await env.DB.prepare("SELECT actor, action FROM audit_log WHERE namespace = ?1 AND path = ?2 ORDER BY id")
    .bind(NS, path)
    .all<{ actor: string; action: string }>();
  return results;
}

describe("an improve document write is a write like any other", () => {
  it("snapshots the prior body, lands the new one, and writes an audit row with the one actor spelling", async () => {
    const path = "improve/archive/r/lorem-4.md";
    await env.DB.prepare("INSERT INTO documents (namespace, path, title, body) VALUES (?1, ?2, 'old', 'lorem old body')")
      .bind(NS, path)
      .run();
    const prior = await env.DB.prepare("SELECT id, title, body FROM documents WHERE namespace = ?1 AND path = ?2")
      .bind(NS, path)
      .first<{ id: number; title: string | null; body: string | null }>();

    await env.DB.batch(
      await improveDocStatements(env.DB, {
        namespace: NS,
        path,
        title: "attempt",
        body: "lorem new body",
        type: "reference",
        prior,
        action: "improve-attempt",
      })
    );

    expect(await versionsOf(path)).toEqual(["lorem old body"]);
    expect((await docOf(path))?.body).toBe("lorem new body");
    expect(await auditsOf(path)).toEqual([{ actor: IMPROVE_ACTOR, action: "improve-attempt" }]);
    expect(IMPROVE_ACTOR).toBe("improve-loop");
  });

  it("normalizes wide dashes in the stored title and body", async () => {
    // A document written by a model is the most likely source of a wide dash.
    const path = "improve/archive/r/lorem-5.md";
    const title = `a ${EM_DASH} title`;
    const body = `a body ${EM_DASH} with a wide dash, and an ${EN_DASH} en dash`;
    // Vacuity guard first: the fixture really does carry the characters.
    expect(title).toMatch(WIDE_DASH);
    expect(body).toMatch(WIDE_DASH);

    await env.DB.batch(
      await improveDocStatements(env.DB, { namespace: NS, path, title, body, type: "reference", prior: null, action: "improve-attempt" })
    );

    const stored = await docOf(path);
    expect(stored?.body, "the document was not written").toContain("with a wide dash");
    expect(stored?.title, "the title kept a wide dash").not.toMatch(WIDE_DASH);
    expect(stored?.body, "the body kept a wide dash").not.toMatch(WIDE_DASH);
  });
});
