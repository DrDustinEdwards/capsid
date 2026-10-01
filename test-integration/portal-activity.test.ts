import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { legacyAgent } from "../src/agents";
import { postJob } from "../src/jobs";
import { ACTIVITY_LIMIT, loadActivity } from "../src/portal-activity";

// THE PORTAL'S RECENT ACTIVITY, read from a real audit_log. The node tests read the
// statement's text for the LIMIT and the two filter clauses; these seed more rows than
// the limit, across two namespaces and two actors, and assert which rows come back.

// Twice the limit, so the act-b filter alone (two rows in three) also matches more
// rows than the limit.
const TOTAL = ACTIVITY_LIMIT * 2;

async function seed(): Promise<void> {
  // Interleaved, so neither filter can be satisfied by taking a contiguous run of ids.
  const insert = env.DB.prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES (?1, 'write', ?2, ?3, '{}')");
  await env.DB.batch(
    Array.from({ length: TOTAL }, (_, i) =>
      insert.bind(i % 2 === 0 ? "agent:lorem" : "agent:ipsum", i % 3 === 0 ? "act-a" : "act-b", `doc-${i}.md`)
    )
  );
}

describe("loadActivity against a real audit_log", () => {
  it("returns the newest ACTIVITY_LIMIT rows, newest first, and only those, whatever the filters", async () => {
    await seed();
    // Every row in the table, not only the seeded ones, so a row another test left
    // behind cannot make the expectation disagree with the store.
    const { results: all } = await env.DB.prepare("SELECT actor, namespace, path FROM audit_log ORDER BY id DESC").all<{
      actor: string;
      namespace: string;
      path: string;
    }>();
    expect(all.length).toBeGreaterThanOrEqual(TOTAL);

    const unfiltered = await loadActivity(env.DB, { namespace: null, actor: null, id: null });
    expect(unfiltered.map((r) => r.path)).toEqual(all.slice(0, ACTIVITY_LIMIT).map((r) => r.path));

    const byNamespace = await loadActivity(env.DB, { namespace: "act-b", actor: null, id: null });
    expect(all.filter((r) => r.namespace === "act-b").length).toBeGreaterThan(ACTIVITY_LIMIT);
    const expectedNs = all.filter((r) => r.namespace === "act-b").slice(0, ACTIVITY_LIMIT);
    expect(byNamespace.map((r) => r.path)).toEqual(expectedNs.map((r) => r.path));

    const byActor = await loadActivity(env.DB, { namespace: null, actor: "agent:ipsum", id: null });
    expect(byActor.map((r) => r.path)).toEqual(all.filter((r) => r.actor === "agent:ipsum").slice(0, ACTIVITY_LIMIT).map((r) => r.path));

    const both = await loadActivity(env.DB, { namespace: "act-a", actor: "agent:lorem", id: null });
    const expectedBoth = all.filter((r) => r.namespace === "act-a" && r.actor === "agent:lorem").slice(0, ACTIVITY_LIMIT);
    expect(expectedBoth.length).toBeGreaterThan(0);
    expect(both.map((r) => r.path)).toEqual(expectedBoth.map((r) => r.path));
  });
});

// Reported 2026-09-29: "job-posted" twice, same actor, same second, same path. Both rows
// are real and intended: a job transition writes one audit row for the job (params carry
// job_id) and one for its mirror document (params carry bytes and sha256), as every
// document write does. The Activity read says which is which.
describe("a job transition's two audit rows", () => {
  it("PLANT: are told apart, the job's row and its mirror document's", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
      .bind("capsid", JSON.stringify([{ repo: "example/capsid", label: "primary" }]))
      .run();
    const posted = await postJob(env as never, legacyAgent("write", "github:sample"), new Date(), {
      namespace: "capsid",
      title: "a job whose post is read back from Activity",
      body: "do the thing",
    });
    expect(posted.ok, posted.refusal).toBe(true);
    const path = `jobs/${posted.job!.id}.md`;
    const rows = (await loadActivity(env.DB, { namespace: "capsid", actor: "github:sample", id: null })).filter((r) => r.path === path);
    expect(rows.map((r) => r.action)).toEqual(["job-posted", "job-posted"]);
    expect(rows.map((r) => r.target).sort()).toEqual(["document", "job"]);
    expect(new Set(rows.map((r) => r.id)).size, "two rows share an id, so a view keyed on it would drop one").toBe(2);
  });

  it("a row whose params are not JSON, or name neither, has no target rather than failing the read", async () => {
    await env.DB.prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('agent:sample', 'write', 'act-z', 'z.md', 'not json')").run();
    await env.DB.prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('agent:sample', 'write', 'act-z', 'y.md', '{}')").run();
    const rows = await loadActivity(env.DB, { namespace: "act-z", actor: null, id: null });
    expect(rows.map((r) => r.target)).toEqual([null, null]);
  });
});

// The Activity drawer's read: one row by id, its params turned into named fields here and
// never handed out raw (src/audit-detail.ts).
describe("one audit row by id", () => {
  it("PLANT: comes back alone with its reason and its before and after, and its hash is withheld", async () => {
    const params = {
      reason: "the origin moved",
      before: { namespace: "act-d", origin: "https://a.example.com", revision: 1 },
      after: { namespace: "act-d", origin: "https://b.example.com", revision: 2 },
      sha256: "f".repeat(64),
    };
    const row = await env.DB.prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('access:admin@example.com', 'ops-site-edited', 'act-d', NULL, ?1) RETURNING id")
      .bind(JSON.stringify(params))
      .first<{ id: number }>();
    await env.DB.prepare("INSERT INTO audit_log (actor, action, namespace, path, params) VALUES ('agent:sample', 'write', 'act-d', 'after.md', '{}')").run();

    const rows = await loadActivity(env.DB, { namespace: "some-other", actor: "agent:nobody", id: row!.id });
    expect(rows.map((r) => r.id), "the id read ignores the namespace and actor filters").toEqual([row!.id]);
    const detail = rows[0]!.detail;
    expect(detail.reason).toBe("the origin moved");
    expect(detail.changes).toEqual([
      { field: "Origin", before: "https://a.example.com", after: "https://b.example.com" },
      { field: "Revision", before: "1", after: "2" },
    ]);
    expect(detail.withheld).toBe(1);
    expect(JSON.stringify(rows[0])).not.toContain("f".repeat(64));
    expect(Object.keys(rows[0]!)).not.toContain("params");
  });

  it("an id with no row is no rows, not the whole log", async () => {
    expect(await loadActivity(env.DB, { namespace: null, actor: null, id: 9_999_999 })).toEqual([]);
  });
});
