import { env } from "cloudflare:test";
import { resetCapsidDb } from "./reset-db";
import { beforeEach, describe, expect, it } from "vitest";
import { watcherTick, type Gathered } from "../src/watcher";
import { WATCHER_CHECKS } from "../src/watcher-checks";
import { siteMapFindings } from "../src/watcher-detect";
import { ciFindings, type Finding } from "../src/watcher-detect";
import { CI_RED_HOURS } from "../src/watcher-detect";
import {
  REOPEN_QUIET_MS,
  d1FindingMemory,
  type EvidenceEntry,
  type FindingRow,
} from "../src/watcher-findings";

// ci-red was once filed 13 times in four days: its fingerprint carried the head sha, so every red commit was a new finding.
// The watcher's memory is one watcher_findings row per fingerprint. Driven through the tick against a real D1.

const SECRET = "test-root-secret";
const NOW = new Date("2026-09-12T12:00:00.000Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

const tickEnv = () =>
  ({ ...env, IMPROVE_SCORE_SECRET: SECRET }) as unknown as Parameters<typeof watcherTick>[0];

function gathered(findings: Finding[]): () => Promise<Gathered> {
  return async () => ({
    findings,
    ran: new Set(WATCHER_CHECKS),
    observed: { health: null, offaccount: null, ci: [], siteMap: null, probes: null },
  });
}

async function pass(when: Date, findings: Finding[]) {
  return watcherTick(tickEnv(), when, gathered(findings), { force: true });
}

async function findingRows(prefix: string) {
  const { results } = await env.DB.prepare(
    "SELECT fingerprint, state FROM watcher_findings WHERE fingerprint LIKE ?1 ORDER BY fingerprint",
  )
    .bind(`${prefix}%`)
    .all<{ fingerprint: string; state: string }>();
  return results ?? [];
}

const redRun = (sha: string, when: Date, hoursOld: number) => ({
  head_sha: sha,
  status: "completed",
  conclusion: "failure",
  created_at: new Date(when.getTime() - hoursOld * 3_600_000).toISOString(),
});

const SITE_MAP_DRIFT = () => siteMapFindings({ unmapped: ["sample"], unknown: [] });

beforeEach(async () => {
  await resetCapsidDb();
  for (const ns of ["capsid", "sample"]) {
    await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES (?1, ?2)")
      .bind(ns, JSON.stringify([{ repo: `example/${ns}`, label: "primary" }]))
      .run();
  }
});

describe("reproduction: the refile the watcher's memory exists to stop", () => {
  it("REPRODUCE: a red CI whose head sha changes is one incident, recorded once", async () => {
    const first = await pass(
      NOW,
      ciFindings(
        "sample",
        [redRun("aaaaaaa1111111111111111111111111111111aa", NOW, CI_RED_HOURS + 1)],
        NOW,
      ),
    );
    expect(first.recorded).toEqual(["ci-red-sample"]);

    const later = at(3);
    const second = await pass(
      later,
      ciFindings(
        "sample",
        [redRun("bbbbbbb2222222222222222222222222222222bb", later, CI_RED_HOURS + 0.5)],
        later,
      ),
    );
    expect(second.cleared, "the incident was cleared while the branch was still red").toEqual([]);
    expect(
      await findingRows("ci-red-"),
      "a new head sha on a branch that is still red was recorded as a new finding",
    ).toEqual([{ fingerprint: "ci-red-sample", state: "open" }]);

    const row = await findingRow("ci-red-sample");
    expect(row).toMatchObject({ state: "open", seen_count: 2 });
    const evidence = JSON.parse(row!.evidence) as EvidenceEntry[];
    expect(evidence.map((e) => e.lines.find((l) => l.startsWith("head sha: ")))).toEqual([
      "head sha: aaaaaaa1111111111111111111111111111111aa",
      "head sha: bbbbbbb2222222222222222222222222222222bb",
    ]);
  });
});

async function findingRow(fingerprint: string) {
  return env.DB.prepare("SELECT * FROM watcher_findings WHERE fingerprint = ?1")
    .bind(fingerprint)
    .first<FindingRow>();
}

describe("the finding's row across passes", () => {
  it("a finding a person dismissed stays dismissed while seen, clears when it stops, stays quiet six hours, and opens again after", async () => {
    const [f] = SITE_MAP_DRIFT();
    expect((await pass(NOW, [f])).recorded).toEqual([f.fingerprint]);
    expect(await findingRow(f.fingerprint)).toMatchObject({
      state: "open",
      seen_count: 1,
      namespace: "capsid",
    });

    await env.DB.prepare("UPDATE watcher_findings SET state = 'dismissed' WHERE fingerprint = ?1")
      .bind(f.fingerprint)
      .run();
    expect((await pass(at(1), [f])).recorded).toEqual([]);
    expect(await findingRow(f.fingerprint)).toMatchObject({
      state: "dismissed",
      seen_count: 2,
      reopen_after: null,
    });

    await pass(at(2), []);
    expect(await findingRow(f.fingerprint)).toMatchObject({
      state: "cleared",
      cleared_at: at(2).toISOString(),
      reopen_after: new Date(at(2).getTime() + REOPEN_QUIET_MS).toISOString(),
    });

    expect((await pass(at(3), [f])).recorded).toEqual([]);
    expect(await findingRow(f.fingerprint)).toMatchObject({ state: "cleared", seen_count: 3 });

    expect((await pass(at(9), [f])).recorded).toEqual([f.fingerprint]);
    expect(await findingRow(f.fingerprint)).toMatchObject({
      state: "open",
      cleared_at: null,
      reopen_after: null,
      seen_count: 4,
    });
  });

  it("a state move is guarded on the state it was read in, and reports a lost race", async () => {
    const memory = d1FindingMemory(tickEnv());
    const f = {
      fingerprint: "backup-stale",
      namespace: "sample",
      title: "Watcher: t [backup-stale]",
    };
    await memory.insert(f, NOW);
    const stale = (await findingRow("backup-stale"))!;
    expect(await memory.clear(stale, at(1))).toBe(true);
    // A second pass holding the same read loses every move.
    expect(await memory.clear(stale, at(1))).toBe(false);
    expect(await memory.sight(stale, f, at(1))).toBe(false);
    expect(await memory.open(stale, f, at(1))).toBe(false);
    expect(await findingRow("backup-stale")).toMatchObject({ state: "cleared", seen_count: 1 });
    const cleared = (await findingRow("backup-stale"))!;
    expect(await memory.open(cleared, f, at(2))).toBe(true);
    expect(await memory.clear(cleared, at(2)), "a move from a state the row has left").toBe(false);
    expect((await findingRow("backup-stale"))?.state).toBe("open");
  });
});
