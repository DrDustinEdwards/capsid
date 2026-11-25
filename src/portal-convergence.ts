import { jsonResponse } from "@dustinedwards/site-runtime/http";
import type { PortalConvergence } from "./ops-types/views";
import { behindGate } from "./portal-auth";
import { readConvergence } from "./site-convergence";

// The Portal's convergence view: GET /portal/api/convergence. Each site that opted into Capsid
// calling its operator API, read live (src/site-convergence.ts).

export const PORTAL_CONVERGENCE_PATH = "/portal/api/convergence";

/** GET /portal/api/convergence: every opted-in site's convergence, read now. */
export const handlePortalConvergence = behindGate(
  async (_request, env, now, _user, fetchImpl: typeof fetch = fetch) => {
    const body: PortalConvergence = {
      generated: now.toISOString(),
      sites: await readConvergence(env, fetchImpl, now),
    };
    return jsonResponse(body);
  },
);
