import type { PortalDigest, PortalPlan } from "./ops-types/views";
import { digestSinceFrom, readOvernightDigest } from "./overnight-digest";
import { readOvernightPlan } from "./overnight-plan";
import { behindGate } from "./portal-auth";
import { jsonResponse as json } from "@dustinedwards/site-runtime/http";

// The Portal's Tonight plan and its "since you last looked" strip
// (docs/design/design-portal-evaluation.md, DECIDE 3): GET /portal/api/plan and GET
// /portal/api/digest.

export const PORTAL_PLAN_PATH = "/portal/api/plan";
export const PORTAL_DIGEST_PATH = "/portal/api/digest";

/** GET /portal/api/plan: what an overnight run would work, per repo, and what it skips. */
export const handlePortalPlan = behindGate(async (_request, env, now) => {
  const { for_namespace: _all, ...plan } = await readOvernightPlan(env, {}, now);
  const body: PortalPlan = plan;
  return json(body);
});

/** GET /portal/api/digest?since=: what finished, blocked and is ready since then. */
export const handlePortalDigest = behindGate(async (request, env, now) => {
  const since = digestSinceFrom(new URL(request.url).searchParams.get("since") ?? undefined, now);
  if (!since.ok)
    return new Response(since.refusal, {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  const body: PortalDigest = await readOvernightDigest(env, { since: since.since }, now);
  return json(body);
});
