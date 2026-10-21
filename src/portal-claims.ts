import type { Env } from "./env";
import { claimsFilterFrom, readClaimsAggregate, readJobClaims } from "./job-claims-read";
import { OPS_RETURN_TO } from "./ops-feed";
import type { PortalClaimsAggregate, PortalClaimsJob } from "./ops-types/claims";
import { portalGate } from "./portal-auth";
import { jsonResponse, textResponse } from "./http";

// The Portal's Claims view: GET /portal/api/claims. The same readers the `capsid_admin_read_claims` tool
// uses (src/job-claims-read.ts), so the view and the tool cannot disagree. A route, not
// a tool, so no grant is checked here (one enforcement point, test/route-gates.test.ts): it
// answers to portalGate, the administrator's Access session, and src/scope.ts lists it
// among the routes gated some other way.

export const PORTAL_CLAIMS_PATH = "/portal/api/claims";

const MAX_JOB_ID = 64;

/** GET /portal/api/claims?job=<id>: one job's claims, evaluations and touches.
 *  GET /portal/api/claims?namespace=&agent=&since=&until=: the per-agent aggregate. */
export async function handlePortalClaims(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const url = new URL(request.url);
  const id = url.searchParams.get("job")?.trim();
  if (id) {
    if (id.length > MAX_JOB_ID) return textResponse(`a job id is at most ${MAX_JOB_ID} characters.`, 400);
    const job = await readJobClaims(env.DB, id);
    if (!job) return jsonResponse({ error: `no job ${id}` }, 404);
    const body: PortalClaimsJob = { generated: now.toISOString(), ...job };
    return jsonResponse(body);
  }
  const parsed = claimsFilterFrom({
    namespace: url.searchParams.get("namespace"),
    agent: url.searchParams.get("agent"),
    since: url.searchParams.get("since"),
    until: url.searchParams.get("until"),
  });
  if (!parsed.ok) return textResponse(parsed.refusal, 400);
  const body: PortalClaimsAggregate = { generated: now.toISOString(), ...(await readClaimsAggregate(env.DB, parsed.filter)) };
  return jsonResponse(body);
}
