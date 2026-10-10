import type { Env } from "./env";
import { OPS_RETURN_TO } from "./ops-feed";
import type { PortalConvergence } from "./ops-types";
import { portalGate } from "./portal-auth";
import { readConvergence } from "./site-convergence";

// The Portal's convergence view: GET /portal/api/convergence (job_09e5f6cbf782). Each site
// that opted into Capsid calling its operator API, read live (src/site-convergence.ts).
// It calls only the site's read (sync_status) and its public health route, and reads the
// site Worker's secret names from Cloudflare; a repair is the site_repair control, never
// this route. A route, not a tool, so no grant is checked here (CLAUDE.md, one
// enforcement point rule): it answers to portalGate, and src/scope.ts lists it among the
// routes gated some other way.

export const PORTAL_CONVERGENCE_PATH = "/portal/api/convergence";

/** GET /portal/api/convergence: every opted-in site's convergence, read now. */
export async function handlePortalConvergence(request: Request, env: Env, now: Date = new Date(), fetchImpl: typeof fetch = fetch): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const body: PortalConvergence = { generated: now.toISOString(), sites: await readConvergence(env, fetchImpl, now) };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
