import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { portalSessionCookie } from "../src/portal-auth";
import type { Env } from "../src/env";
import type { PortalClaimsAggregate, PortalClaimsJob } from "../src/ops-types";
import { PORTAL_CLAIMS_PATH } from "../src/portal-claims";

// GET /portal/api/claims through the whole Worker against a real D1: the route reads
// through the same readers as the claims tool (src/job-claims-read.ts), behind
// portalGate. The gate itself, a bearer's 403 and an anonymous caller's sign-in, is
// driven for every Portal route in test-integration/route-gates.test.ts. The tables
// are append-only, so the rows here live under their own namespace and job id.

const ORIGIN = "https://capsid.test";
const SECRET = "integration-portal-claims-key";
const NS = "portal-claims-sample";
const JOB = "job_c1a1c1a1c1a1";
const AGENT = "agent:sample-driver";

function workerEnv(): Env {
  return { ...(env as unknown as Env), COOKIE_ENCRYPTION_KEY: SECRET };
}

async function get(query: string): Promise<Response> {
  const session = (await portalSessionCookie({ email: "admin@example.com" }, SECRET, new Date())).split(";")[0];
  const ctx = createExecutionContext();
  const request = new Request(`${ORIGIN}${PORTAL_CLAIMS_PATH}${query}`, { headers: { Cookie: session, "Sec-Fetch-Site": "same-origin" }, redirect: "manual" });
  const response = await worker.fetch!(request as never, workerEnv() as never, ctx);
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}

// Once per storage: planted rows cannot be deleted, so a second plant would double them.
async function plant(): Promise<void> {
  if (await env.DB.prepare("SELECT 1 AS n FROM jobs WHERE id = ?1").bind(JOB).first()) return;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO jobs (id, namespace, title, body, status, posted_by, claimed_by) VALUES (?1, ?2, 'a sample job', 'body', 'done', 'github:sample', ?3)`
    ).bind(JOB, NS, AGENT),
    env.DB.prepare(`INSERT INTO job_claims (job_id, action, agent, namespace, raw, commits) VALUES (?1, 'complete', ?2, ?3, '{}', 4)`).bind(JOB, AGENT, NS),
    env.DB.prepare(
      `INSERT INTO job_evaluations (job_id, claim_id, name, score_value, score_label, claimed, verified, agreement, evaluator, evaluator_id)
       VALUES (?1, (SELECT MAX(id) FROM job_claims WHERE job_id = ?1), 'commits', 4, 'pass', '4', '4', 'agree', 'worker', 'capsid@unknown')`
    ).bind(JOB),
    env.DB.prepare(`INSERT INTO job_touches (job_id, namespace, kind, actor, actor_kind, waited_ms) VALUES (?1, ?2, 'approval', 'access:admin@example.com', 'human', 5000)`).bind(JOB, NS),
  ]);
}

describe("GET /portal/api/claims", () => {
  it("answers the aggregate for a namespace, uncached, as the tool reads it", async () => {
    await plant();
    const response = await get(`?namespace=${NS}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as PortalClaimsAggregate;
    expect(body.generated).toMatch(/T.*Z$/);
    expect(body.filter).toEqual({ namespace: NS, agent: null, since: null, until: null });
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toMatchObject({ agent: AGENT, namespace: NS, jobs: 1, claims: 1 });
    expect(body.groups[0].evaluations.commits).toEqual({ agree: 1, disagree: 0, unclaimed: 0, unchecked: 0 });
    expect(body.groups[0].touches.waited_ms_median).toBe(5000);
  });

  it("answers one job with ?job=, and a JSON 404 for a job that does not exist", async () => {
    await plant();
    const response = await get(`?job=${JOB}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as PortalClaimsJob;
    expect(body.job.id).toBe(JOB);
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0].commits).toBe(4);
    expect(body.evaluations[0].claim_id).toBe(body.claims[0].id);
    expect(body.touches.map((t) => t.kind)).toEqual(["approval"]);
    expect(body.outcome).toBeNull();

    const missing = await get("?job=job_000000000000");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Content-Type")).toContain("application/json");
  });

  it("refuses a since that is not an ISO time with a text 400", async () => {
    const response = await get("?since=yesterday");
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/since must be an ISO 8601 time/);
  });
});
