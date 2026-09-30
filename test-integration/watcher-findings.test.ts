import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CI_RED_HOURS, WATCHER_ACTOR, WATCHER_CHECKS, ciFindings, siteMapFindings, watcherTick, type Finding, type Gathered } from "../src/watcher";
import { MAX_EVIDENCE, REOPEN_QUIET_MS, d1FindingMemory, type EvidenceEntry, type FindingRow } from "../src/watcher-findings";

// The watcher's memory of a finding across jobs (migrations/0024_watcher_findings.sql),
// driven through the tick against a real D1, so the job rows the queue holds are the
// thing asserted on.
//
// THE REFILES THIS FILE REPRODUCES (job queue: watcher dedupe). The only memory the
// watcher had of a finding was an open job with the fingerprint in its title, so:
//   - the site-map drift finding was filed again within an hour of the seat
//     superseding it, because a superseded job is not open;
//   - ci-red was filed 13 times between 2026-09-20 and 09-23, because its fingerprint
//     carried the head sha and every red commit was a new finding.

const SECRET = "test-root-secret";
const NOW = new Date("2026-09-12T12:00:00.000Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

const tickEnv = () => ({ ...env, IMPROVE_SCORE_SECRET: SECRET }) as unknown as Parameters<typeof watcherTick>[0];

function gathered(findings: Finding[]): () => Promise<Gathered> {
  return async () => ({
    findings,
    ran: new Set(WATCHER_CHECKS),
    observed: { health: null, mirror: null, ci: [], siteMap: null, probes: null },
  });
}

async function pass(when: Date, findings: Finding[]) {
  return watcherTick(tickEnv(), when, gathered(findings), { force: true });
}

async function watcherJobs(titlePart: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, title, status, result_summary FROM jobs WHERE posted_by = ?1 AND instr(title, ?2) > 0 ORDER BY created_at, id"
  )
    .bind(WATCHER_ACTOR, titlePart)
    .all<{ id: string; title: string; status: string; result_summary: string | null }>();
  return results ?? [];
}

// A red run on the default branch, completed `hoursOld` before `when`.
const redRun = (sha: string, when: Date, hoursOld: number) => ({
  head_sha: sha,
  status: "completed",
  conclusion: "failure",
  created_at: new Date(when.getTime() - hoursOld * 3_600_000).toISOString(),
});

const SITE_MAP_DRIFT = () => siteMapFindings({ unmapped: ["sample"], unknown: [] });

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM jobs").run();
  await env.DB.prepare("DELETE FROM audit_log").run();
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  await env.DB.prepare("DELETE FROM watcher_findings").run();
  for (const ns of ["capsid", "sample"]) {
    await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
      .bind(ns, JSON.stringify([{ repo: `example/${ns}`, label: "primary" }]))
      .run();
  }
});

describe("reproduction: the refiles the watcher's memory exists to stop", () => {
  it("REPRODUCE: a superseded site-map drift finding is not filed again on the next pass", async () => {
    const first = await pass(NOW, SITE_MAP_DRIFT());
    expect(first.posted).toHaveLength(1);
    const [job] = await watcherJobs("site-map-drift-");
    expect(job.status).toBe("queued");

    // The seat withdraws it while the drift still holds.
    await env.DB.prepare("UPDATE jobs SET status = 'superseded', result_summary = 'withdrawn by the seat', updated_at = ?2 WHERE id = ?1")
      .bind(job.id, at(0.5).toISOString())
      .run();

    const second = await pass(at(1), SITE_MAP_DRIFT());
    expect(second.posted, "a finding a person ended was filed again while it still held").toEqual([]);
    expect(await watcherJobs("site-map-drift-")).toHaveLength(1);
  });

  it("REPRODUCE: a red CI whose head sha changes is one incident, filed once", async () => {
    const first = await pass(NOW, ciFindings("sample", [redRun("aaaaaaa1111111111111111111111111111111aa", NOW, CI_RED_HOURS + 1)], NOW));
    expect(first.posted).toHaveLength(1);

    // A second red commit lands on the same red branch.
    const later = at(3);
    const second = await pass(later, ciFindings("sample", [redRun("bbbbbbb2222222222222222222222222222222bb", later, CI_RED_HOURS + 0.5)], later));
    expect(second.posted, "a new head sha on a branch that is still red was filed as a new finding").toEqual([]);
    const jobs = await watcherJobs("CI is red");
    expect(jobs, jobs.map((j) => `${j.title} ${j.status}`).join("; ")).toHaveLength(1);
    expect(jobs[0].status, "the incident's job was closed as cleared while the branch was still red").toBe("queued");
  });
});

async function findingRow(fingerprint: string) {
  return env.DB.prepare("SELECT * FROM watcher_findings WHERE fingerprint = ?1").bind(fingerprint).first<FindingRow>();
}

describe("the finding's row across jobs", () => {
  it("a finding a person ended is dismissed, clears when it stops, stays quiet six hours, and is filed again after", async () => {
    const [f] = SITE_MAP_DRIFT();
    await pass(NOW, [f]);
    const [job] = await watcherJobs("site-map-drift-");
    expect(await findingRow(f.fingerprint)).toMatchObject({ state: "open", job_id: job.id, seen_count: 1, namespace: "capsid" });

    await env.DB.prepare("UPDATE jobs SET status = 'superseded', updated_at = ?2 WHERE id = ?1").bind(job.id, at(0.5).toISOString()).run();
    const dismissed = await pass(at(1), [f]);
    expect(dismissed.posted).toEqual([]);
    expect(await findingRow(f.fingerprint)).toMatchObject({ state: "dismissed", job_id: job.id, seen_count: 2, reopen_after: null });

    // The drift is fixed; the site map check ran and did not see it.
    await pass(at(2), []);
    expect(await findingRow(f.fingerprint)).toMatchObject({
      state: "cleared",
      cleared_at: at(2).toISOString(),
      reopen_after: new Date(at(2).getTime() + REOPEN_QUIET_MS).toISOString(),
    });

    // Back inside the quiet period: counted, not filed.
    expect((await pass(at(3), [f])).posted).toEqual([]);
    expect(await findingRow(f.fingerprint)).toMatchObject({ state: "cleared", seen_count: 3 });

    // Back after it: a recurrence, filed once, on a new job.
    const again = await pass(at(9), [f]);
    expect(again.posted).toEqual([f.fingerprint]);
    const jobs = await watcherJobs("site-map-drift-");
    expect(jobs).toHaveLength(2);
    expect(await findingRow(f.fingerprint)).toMatchObject({ state: "open", job_id: jobs[1].id, cleared_at: null, reopen_after: null, seen_count: 4 });
  });

  it("a red CI's head shas are its evidence, newest last", async () => {
    await pass(NOW, ciFindings("sample", [redRun("aaaaaaa1111111111111111111111111111111aa", NOW, CI_RED_HOURS + 1)], NOW));
    const later = at(3);
    await pass(later, ciFindings("sample", [redRun("bbbbbbb2222222222222222222222222222222bb", later, CI_RED_HOURS + 0.5)], later));
    const row = await findingRow("ci-red-sample");
    expect(row).toMatchObject({ state: "open", seen_count: 2 });
    const evidence = JSON.parse(row!.evidence) as EvidenceEntry[];
    expect(evidence.map((e) => e.lines.find((l) => l.startsWith("head sha: ")))).toEqual([
      "head sha: aaaaaaa1111111111111111111111111111111aa",
      "head sha: bbbbbbb2222222222222222222222222222222bb",
    ]);
  });

  it("a job the watcher itself cleared, whose row missed the move, stays quiet from when the job cleared", async () => {
    const [f] = SITE_MAP_DRIFT();
    await pass(NOW, [f]);
    const [job] = await watcherJobs("site-map-drift-");
    // The job was cleared an hour later and the row write was lost.
    await env.DB.prepare("UPDATE jobs SET status = 'failed', result_summary = 'cleared', updated_at = ?2 WHERE id = ?1").bind(job.id, at(1).toISOString()).run();
    expect((await pass(at(2), [f])).posted).toEqual([]);
    expect((await findingRow(f.fingerprint))?.state).toBe("open");
    expect((await pass(at(8), [f])).posted).toEqual([f.fingerprint]);
  });

  it("an open job posted before the table existed is adopted, not filed again", async () => {
    const [f] = SITE_MAP_DRIFT();
    await env.DB.prepare(
      `INSERT INTO jobs (id, namespace, title, body, status, posted_by, created_at, updated_at)
       VALUES ('job_legacy00001', 'capsid', ?1, 'lorem body', 'queued', ?2, ?3, ?3)`
    )
      .bind(f.title, WATCHER_ACTOR, NOW.toISOString())
      .run();
    expect((await pass(at(1), [f])).posted).toEqual([]);
    expect(await findingRow(f.fingerprint)).toMatchObject({ state: "open", job_id: "job_legacy00001", seen_count: 1 });
  });

  it("keeps the newest MAX_EVIDENCE sightings", async () => {
    const memory = d1FindingMemory(tickEnv());
    const f = { fingerprint: "backup-stale", namespace: "sample", title: "Watcher: t [backup-stale]", evidence: ["sighting 0"] };
    expect(await memory.insert(f, "open", "job_000000000001", NOW)).toBe(true);
    expect(await memory.insert(f, "open", "job_000000000002", NOW), "a second first row").toBe(false);
    for (let i = 1; i < MAX_EVIDENCE + 5; i++) {
      const row = (await findingRow("backup-stale"))!;
      expect(await memory.sight(row, { ...f, evidence: [`sighting ${i}`] }, at(i))).toBe(true);
    }
    const row = (await findingRow("backup-stale"))!;
    expect(row.seen_count).toBe(MAX_EVIDENCE + 5);
    const evidence = JSON.parse(row.evidence) as EvidenceEntry[];
    expect(evidence).toHaveLength(MAX_EVIDENCE);
    expect(evidence[0].lines).toEqual(["sighting 5"]);
    expect(evidence[MAX_EVIDENCE - 1].lines).toEqual([`sighting ${MAX_EVIDENCE + 4}`]);
  });

  it("a state move is guarded on the state it was read in, and reports a lost race", async () => {
    const memory = d1FindingMemory(tickEnv());
    const f = { fingerprint: "backup-stale", namespace: "sample", title: "Watcher: t [backup-stale]" };
    await memory.insert(f, "open", "job_000000000001", NOW);
    const stale = (await findingRow("backup-stale"))!;
    expect(await memory.clear(stale, at(1))).toBe(true);
    // A second pass holding the same read loses every move.
    expect(await memory.clear(stale, at(1))).toBe(false);
    expect(await memory.dismiss(stale, f, at(1))).toBe(false);
    expect(await memory.sight(stale, f, at(1))).toBe(false);
    expect(await memory.open(stale, f, "job_000000000002", at(1))).toBe(false);
    expect(await findingRow("backup-stale")).toMatchObject({ state: "cleared", job_id: "job_000000000001", seen_count: 1 });
    // And a dismissal is keyed on the job the row was read with.
    const cleared = (await findingRow("backup-stale"))!;
    expect(await memory.open(cleared, f, "job_000000000003", at(2))).toBe(true);
    expect(await memory.dismiss({ ...cleared, state: "open", job_id: "job_000000000001" }, f, at(2))).toBe(false);
    expect((await findingRow("backup-stale"))?.state).toBe("open");
  });
});
