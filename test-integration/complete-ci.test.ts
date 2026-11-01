import { env } from "cloudflare:test";
import { resetCapsidDb } from "./reset-db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { claimJob, completeJob, failAsCaller, postJob } from "../src/jobs";
import { breakerState } from "../src/job-breaker";
import { legacyAgent } from "../src/agents";
import { readJob } from "../src/jobs-transition";

// The CI gate on complete (src/complete-ci.ts) against real D1, with GitHub as a fetch stub.

const NS = "sample";
const PR = (n: number) => `https://github.com/example/sample/pull/${n}`;
const DRIVER = legacyAgent("write", "agent:driver-aaaa");
const SEAT = legacyAgent("write", "access:seat@example.com");
const NOW = new Date("2026-10-23T12:00:00.000Z");

function jobsEnv() {
  return { ...env, IMPROVE_SCORE_SECRET: "test-root-secret", GITHUB_APP_CLIENT_ID: "Iv1.test", GITHUB_APP_PRIVATE_KEY: "unused: the token is cached" } as unknown as Parameters<typeof postJob>[0];
}

type Check = { name: string; status: string; conclusion: string | null };
// Per pull request: the check runs on its head, and the files it changes.
// A file is its name (modified, lines added only) or GitHub's row for it.
type File = string | { filename: string; status: string };
const github = new Map<number, { checks: Check[]; files: File[] }>();

beforeEach(async () => {
  await resetCapsidDb();
  await env.DB.prepare("INSERT OR REPLACE INTO namespaces (namespace, repos) VALUES (?1, ?2)").bind(NS, JSON.stringify([{ repo: "example/sample", label: "primary" }])).run();
  await env.APP_KV.put("gh:token:v3:example/sample", "test-token");
  github.clear();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    const pr = /\/pulls\/(\d+)(\/files)?$/.exec(path);
    if (pr) {
      const n = Number(pr[1]);
      if (pr[2]) return Response.json(github.get(n)!.files.map((f) => (typeof f === "string" ? { filename: f, status: "modified", additions: 1, deletions: 0, patch: "+x" } : f)));
      return Response.json({ merged: false, head: { sha: String(n).padStart(40, "0") }, commits: 1, changed_files: 1 });
    }
    const checks = /\/commits\/0*(\d+)\/check-runs$/.exec(path);
    if (checks) return Response.json({ check_runs: github.get(Number(checks[1]))!.checks });
    return Response.json([]);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.APP_KV.delete("gh:token:v3:example/sample");
});

async function claimed(title: string, body = "do the thing") {
  const posted = await postJob(jobsEnv(), SEAT, NOW, { namespace: NS, title, body } as Parameters<typeof postJob>[3]);
  const id = posted.job!.id;
  expect((await claimJob(jobsEnv(), DRIVER, NOW, { id })).ok).toBe(true);
  return id;
}

const complete = (id: string, pr: number) => completeJob(jobsEnv(), DRIVER, NOW, id, { result_summary: "done", result_ref: PR(pr) });
const run = (conclusion: string | null, status = "completed"): Check => ({ name: "checks", status, conclusion });

it("complete waits on running CI, refuses red, and stays bound to the pull request it refused", async () => {
  const id = await claimed("ci gate");
  github.set(1, { checks: [run(null, "in_progress")], files: ["src/a.ts"] });
  let r = await complete(id, 1);
  expect(r.refusal).toMatch(/has not finished/);

  github.set(1, { checks: [run("failure")], files: ["src/a.ts"] });
  r = await complete(id, 1);
  expect(r.refusal).toMatch(/failed/);
  expect((await readJob(env.DB, id))?.result_ref).toBe(PR(1));

  // A green pull request named instead does not escape the red one the job is bound to.
  github.set(2, { checks: [run("success")], files: ["src/a.ts"] });
  r = await complete(id, 2);
  expect(r.refusal).toMatch(/pull\/1: CI on .* failed/);

  github.set(1, { checks: [run("success"), run("skipped")], files: ["src/a.ts"] });
  r = await complete(id, 1);
  expect(r.ok, r.refusal).toBe(true);
  expect(r.job?.status).toBe("done");
});

it("no check that passed is not green for a code change, and is for docs alone", async () => {
  const code = await claimed("no runs, code");
  github.set(3, { checks: [run("skipped")], files: ["docs/a.md", "src/a.ts"] });
  expect((await complete(code, 3)).refusal).toMatch(/no CI check passed .* changes code \(src\/a\.ts\)/);

  const docs = await claimed("no runs, docs");
  github.set(4, { checks: [], files: ["docs/a.md"] });
  expect((await complete(docs, 4)).ok).toBe(true);
});

it("a pull request that removes a test file is refused, unless the job names it", async () => {
  github.set(5, { checks: [run("success")], files: ["src/a.ts", { filename: "test/a.test.ts", status: "removed" }] });
  expect((await complete(await claimed("drops a test"), 5)).refusal).toMatch(/removes the test file test\/a\.test\.ts/);
  expect((await complete(await claimed("retire a test", "Remove test/a.test.ts; it tests nothing now."), 5)).ok).toBe(true);
});

it("a DONE WHEN item that names a path is not done until a pull request changes it", async () => {
  const body = "DONE WHEN:\n1. The breaker skips run keys: changes `src/job-breaker.ts`";
  github.set(6, { checks: [run("success")], files: ["src/other.ts"] });
  expect((await complete(await claimed("checklist missed", body), 6)).refusal).toMatch(/item 1 changes `src\/job-breaker\.ts`, and no pull request/);
  github.set(7, { checks: [run("success")], files: ["src/job-breaker.ts"] });
  expect((await complete(await claimed("checklist met", body), 7)).ok).toBe(true);
});

it("the breaker leaves out a fail Capsid's refusal forced and one that states its remainder, and counts a plain one", async () => {
  const forced = await claimed("red ci");
  github.set(8, { checks: [run("failure")], files: ["src/a.ts"] });
  await complete(forced, 8);
  expect((await failAsCaller(jobsEnv(), DRIVER, NOW, forced, "CI stays red; the fix needs a schema change")).ok).toBe(true);

  const partly = await claimed("half done", "DONE WHEN:\n1. changes `src/a.ts`\n2. changes `src/b.ts`");
  github.set(9, { checks: [run("success")], files: ["src/a.ts"] });
  await complete(partly, 9);
  expect((await failAsCaller(jobsEnv(), DRIVER, NOW, partly, "REMAINING: 2\nsrc/b.ts needs a decision first.")).ok).toBe(true);

  const plain = await claimed("plain");
  expect((await failAsCaller(jobsEnv(), DRIVER, NOW, plain, "REMAINING: 1")).ok).toBe(true);

  expect((await breakerState(jobsEnv(), NS, new Date())).failed).toBe(1);
});

it("a job that asks for the test on the base needs its run to have passed", async () => {
  const body = "Fix the gate.\nTEST ON BASE";
  github.set(10, { checks: [run("success")], files: ["src/a.ts"] });
  expect((await complete(await claimed("no run yet", body), 10)).refusal).toMatch(/no test-on-base check passed/);
  github.set(11, { checks: [run("success"), { name: "test-on-base", status: "completed", conclusion: "success" }], files: ["src/a.ts"] });
  expect((await complete(await claimed("ran on the base", body), 11)).ok).toBe(true);
});
