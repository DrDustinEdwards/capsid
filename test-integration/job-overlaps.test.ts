import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockJob, claimJob, commandFromSummary, completeJob, postJob } from "../src/jobs";
import { legacyAgent } from "../src/agents";
import { OTHER_PRS_READ } from "../src/job-overlaps";

// Overlap warnings (Track A D1) against real D1, with GitHub as a fetch stub: block and
// complete name a pull request, the Worker reads the files of every other open pull request
// in the repo, and a shared file becomes one line in the summary the seat reads.

const SECRET = "test-root-secret";
const NS = "sample";
const PR = (n: number) => `https://github.com/example/sample/pull/${n}`;
const DRIVER = legacyAgent("write", "agent:driver-aaaa");
const SEAT = legacyAgent("write", "access:seat@example.com");
const NOW = new Date("2026-10-07T12:00:00.000Z");

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: SECRET } as unknown as Parameters<typeof postJob>[0];
}

// files: pull request number -> the files GitHub lists (a string, or [new, old] for a rename).
// open: the numbers GitHub lists as open. failing: pull requests whose file list returns 502.
function stubGitHub(files: Record<number, Array<string | [string, string]>>, open: number[], failing: number[] = []) {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    calls.push(url);
    const path = new URL(url).pathname;
    const fileList = /\/pulls\/(\d+)\/files$/.exec(path);
    if (fileList) {
      const n = Number(fileList[1]);
      if (failing.includes(n)) return new Response("bad gateway", { status: 502 });
      return Response.json((files[n] ?? []).map((f) => (typeof f === "string" ? { filename: f } : { filename: f[0], previous_filename: f[1] })));
    }
    if (path === "/repos/example/sample/pulls") return Response.json(open.map((number) => ({ number })));
    if (/\/pulls\/\d+$/.test(path)) return Response.json({ merged: false, head: { sha: "a".repeat(40) }, commits: 1, changed_files: 1 });
    return new Response("not stubbed", { status: 404 });
  });
  return { calls };
}

async function claimed(title: string) {
  const posted = await postJob(jobsEnv(), SEAT, NOW, { namespace: NS, title, body: "do the thing" } as Parameters<typeof postJob>[3]);
  const id = posted.job!.id;
  expect((await claimJob(jobsEnv(), DRIVER, NOW, { id })).ok).toBe(true);
  return id;
}

beforeEach(async () => {
  for (const table of ["job_outcomes", "jobs", "audit_log", "agents", "job_outcome_prs", "job_claims"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run().catch(() => undefined);
  }
  await env.DB.prepare("DELETE FROM documents WHERE path LIKE 'jobs/%'").run();
  await env.DB.prepare("INSERT OR REPLACE INTO namespaces (namespace, repos) VALUES (?1, ?2)").bind(NS, JSON.stringify([{ repo: "example/sample", label: "primary" }])).run();
  await env.APP_KV.put("gh:token:v3:example/sample", "test-token");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.APP_KV.delete("gh:token:v3:example/sample");
});

describe("overlap warnings on block and complete", () => {
  it("a block whose command names a pull request that shares a file with another open one carries the Overlaps line, before the command", async () => {
    stubGitHub({ 134: ["src/jobs.ts", "docs/a.md"], 130: ["src/jobs.ts"], 140: ["src/other.ts"] }, [130, 134, 140]);
    const id = await claimed("block with an overlap");
    const blocked = await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "needs the seat", command: `gh pr merge ${PR(134)} --squash` });
    expect(blocked.ok, blocked.refusal).toBe(true);
    expect(blocked.overlaps?.overlaps).toEqual([{ pr: 134, other: 130, files: ["src/jobs.ts"] }]);
    const summary = blocked.job?.result_summary ?? "";
    expect(summary).toContain("Overlaps: #134 with #130 (src/jobs.ts). Merge in PR order, oldest first, and rebase the later.");
    // The command is still the last thing, so what the seat runs is what the driver wrote.
    expect(commandFromSummary(summary)).toBe(`gh pr merge ${PR(134)} --squash`);
    const audit = await env.DB.prepare("SELECT params FROM audit_log WHERE action = 'job-block' AND params LIKE ?1").bind(`%${id}%`).first<{ params: string }>();
    expect(JSON.parse(audit!.params).overlaps.overlaps).toHaveLength(1);
  });

  it("a complete whose evidence names an overlapping pull request carries the line in the stored summary", async () => {
    stubGitHub({ 134: ["src/jobs.ts"], 130: ["src/jobs.ts"] }, [130, 134]);
    const id = await claimed("complete with an overlap");
    const done = await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "landed", evidence: { prs: [PR(134)] } });
    expect(done.ok, done.refusal).toBe(true);
    expect(done.overlaps?.overlaps[0]).toMatchObject({ pr: 134, other: 130 });
    const stored = await env.DB.prepare("SELECT result_summary FROM jobs WHERE id = ?1").bind(id).first<{ result_summary: string }>();
    expect(stored?.result_summary).toMatch(/^landed\n\nOverlaps: #134 with #130 \(src\/jobs\.ts\)\./);
  });

  it("a rename collides under its old name", async () => {
    stubGitHub({ 7: [["src/new.ts", "src/old.ts"]], 3: ["src/old.ts"] }, [3, 7]);
    const id = await claimed("rename");
    const done = await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "moved", result_ref: PR(7) });
    expect(done.overlaps?.overlaps).toEqual([{ pr: 7, other: 3, files: ["src/old.ts"] }]);
  });

  it("no shared file adds nothing to the summary", async () => {
    stubGitHub({ 134: ["src/a.ts"], 130: ["src/b.ts"] }, [130, 134]);
    const id = await claimed("no overlap");
    const done = await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "landed", result_ref: PR(134) });
    expect(done.ok, done.refusal).toBe(true);
    expect(done.overlaps).toEqual({ overlaps: [], problem: null });
    expect(done.job?.result_summary).toBe("landed");
  });

  it("a failed read says not checked and still lets the call through", async () => {
    stubGitHub({ 134: ["src/a.ts"], 130: ["src/a.ts"] }, [130, 134], [130]);
    const id = await claimed("a failed read");
    const done = await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "landed", result_ref: PR(134) });
    expect(done.ok, done.refusal).toBe(true);
    expect(done.job?.result_summary).toContain("Overlaps: not checked (#130 files: page 1 returned 502).");
  });

  it("more open pull requests than are read is reported, not cut silently", async () => {
    const open = [1, ...Array.from({ length: OTHER_PRS_READ + 3 }, (_, i) => 100 + i)];
    stubGitHub({ 1: ["src/a.ts"] }, open);
    const id = await claimed("many open");
    const done = await completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "landed", result_ref: PR(1) });
    expect(done.job?.result_summary).toContain("Overlaps: not checked (3 open pull requests were not read).");
  });

  it("a call that names no pull request of the repo reads nothing from GitHub", async () => {
    const { calls } = stubGitHub({}, []);
    const id = await claimed("no pull request");
    const blocked = await blockJob(jobsEnv(), DRIVER, NOW, id, { reason: "needs a push", command: "git -C wt push -u origin feat/x" });
    expect(blocked.ok, blocked.refusal).toBe(true);
    expect(blocked.overlaps).toBeUndefined();
    const other = await claimed("someone else's repo");
    const done = await completeJob(jobsEnv(), DRIVER, NOW, other, { result_summary: "landed", result_ref: "https://github.com/elsewhere/other/pull/5" });
    expect(done.overlaps).toBeUndefined();
    expect(calls.filter((u) => u.includes("/pulls?") || u.endsWith("/files"))).toEqual([]);
  });
});
