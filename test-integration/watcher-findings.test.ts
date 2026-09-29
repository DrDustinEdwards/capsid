import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CI_RED_HOURS, WATCHER_ACTOR, WATCHER_CHECKS, ciFindings, siteMapFindings, watcherTick, type Finding, type Gathered } from "../src/watcher";

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
