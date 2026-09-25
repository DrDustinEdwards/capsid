import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { finalizeRun } from "../src/improve/finalize";
import type { RunRow } from "../src/improve-state";
import { archivePath } from "../src/improve-schema";

// A FINISHED RUN RECORDS ITS CONDITION WHERE ONE QUERY FINDS IT: in the finishing audit
// row and in the run summary document (the improve arc's condition ruling). The node
// test read the positional params of the recorded INSERT; this reads the stored rows
// back from a real D1.

const NS = "sample";

describe("finalizeRun records the run's condition", () => {
  it("the finishing audit row and the stored run summary both carry it", async () => {
    await env.DB.prepare(
      `INSERT INTO improve_runs (id, namespace, mode, started, status, condition, advanced_at)
       VALUES ('sample-r1', ?1, 'api', '2026-09-05 08:00:00', 'finalizing', 'no-memory', '2026-09-05 08:00:00')`
    )
      .bind(NS)
      .run();
    const run = await env.DB.prepare("SELECT * FROM improve_runs WHERE id = 'sample-r1'").first<RunRow>();
    expect(run).not.toBeNull();

    const out = await finalizeRun(env as never, run!, new Date("2026-09-05T08:05:00Z"));
    expect(out.to).toBe("done");

    const audit = await env.DB.prepare(
      "SELECT params FROM audit_log WHERE action = 'improve-run-finished' AND namespace = ?1"
    )
      .bind(NS)
      .first<{ params: string }>();
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit!.params).condition).toBe("no-memory");

    const summary = await env.DB.prepare(
      "SELECT body FROM documents WHERE namespace = ?1 AND path = ?2"
    )
      .bind(NS, archivePath("sample-r1", "run-summary"))
      .first<{ body: string }>();
    expect(summary, "no run summary document was stored").not.toBeNull();
    expect(summary!.body).toMatch(/^- condition: no-memory$/m);
  });
});
