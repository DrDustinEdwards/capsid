import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { readDeployOutcomes } from "../src/deploy-outcomes";

// The deploy-outcome reader against a real D1 with migrations/0038 applied, and GitHub
// answered here: a rolled-back run is recorded once with where production went, its pull
// request found from the commit, and a second pass reads it from D1 instead of GitHub.

const A = "a".repeat(40);
const B = "b".repeat(40);
const API = "https://api.github.com/repos/example/capsid";
const calls: string[] = [];
const passThrough = globalThis.fetch;

beforeEach(async () => {
  calls.length = 0;
  await env.DB.prepare("DELETE FROM deploy_outcomes").run();
  await env.DB.prepare("INSERT OR IGNORE INTO namespaces (namespace, repos) VALUES ('capsid', ?1)").bind(JSON.stringify([{ repo: "example/capsid", label: "primary" }])).run();
  await env.APP_KV.put("gh:token:v3:example/capsid", "test-token");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(API)) return passThrough(input, init);
    const path = url.slice(API.length);
    calls.push(path.split("?")[0]!);
    if (path === "") return Response.json({ default_branch: "master" });
    if (path.startsWith("/actions/runs?")) {
      expect(path).toContain("branch=master&event=push&status=completed");
      return Response.json({ workflow_runs: [{ id: 501, head_sha: A, created_at: "2026-10-10T10:00:00Z", html_url: "https://github.com/example/capsid/actions/runs/501" }] });
    }
    if (path === "/actions/runs/501/jobs?per_page=100") {
      return Response.json({ jobs: [{ id: 77, name: "live gate", conclusion: "failure", steps: [{ name: "verify:live", conclusion: "failure" }, { name: "Roll back the deploy this run shipped", conclusion: "success" }] }] });
    }
    if (path === "/check-runs/77/annotations?per_page=100") return Response.json([{ message: `rolled back: was ${A} (this run's commit ${A}), now ${B}. master still points at the bad commit.` }]);
    if (path === `/commits/${A}/pulls`) return Response.json([{ number: 312 }]);
    return new Response("not stubbed", { status: 404 });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = passThrough;
  await env.APP_KV.delete("gh:token:v3:example/capsid");
});

describe("readDeployOutcomes", () => {
  it("records a rolled-back deploy once, with its pull request, and reads it from D1 on the next pass", async () => {
    const first = await readDeployOutcomes(env as unknown as Env, "capsid");
    expect(first).toMatchObject({ outcome: "rolled_back", run_id: 501, head_sha: A, pr: 312, rollback_from: A, rollback_to: B });
    const row = await env.DB.prepare("SELECT repo, namespace, run_id, outcome, pr FROM deploy_outcomes").first();
    expect(row).toEqual({ repo: "example/capsid", namespace: "capsid", run_id: 501, outcome: "rolled_back", pr: 312 });
    calls.length = 0;
    const second = await readDeployOutcomes(env as unknown as Env, "capsid");
    expect(second).toMatchObject({ outcome: "rolled_back", run_id: 501 });
    expect(calls.filter((c) => c.includes("/jobs") || c.includes("/annotations")), "a known run was read from GitHub again").toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM deploy_outcomes").first<{ n: number }>())?.n).toBe(1);
  });
});
