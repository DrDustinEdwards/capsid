import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { improveDocStatements } from "../src/improve-state";

// THE IMPROVE AND JOB MIRROR WRITER SNAPSHOTS THE LIVE ROW (audit 2026-09-25, item
// E1-2, finding F1-2). improveDocStatements used to bind the body its caller had
// pre-read (priorDoc). The job claim path waits on GitHub between that read and the
// batch, so a write landing in the gap was overwritten with no snapshot of it, which
// hard rule 5 forbids.
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
