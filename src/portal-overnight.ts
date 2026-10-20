import type { Env } from "./env";
import { OPS_RETURN_TO } from "./ops-feed";
import type { PortalDigest, PortalPlan } from "./ops-types";
import { digestSinceFrom, readOvernightDigest, readOvernightPlan } from "./overnight-plan";
import { portalGate } from "./portal-auth";
import { jsonResponse as json } from "./http";

// The Portal's Tonight plan and its "since you last looked" strip
// (docs/design/design-portal-evaluation.md, DECIDE 3, ruled 2026-10-09):
// GET /portal/api/plan and GET /portal/api/digest. The readers behind `capsid_work_jobs` action list
// with view "plan" and view "digest" (src/overnight-plan.ts), over every namespace, so the
// Portal and chat cannot disagree. Their own routes, read when the page that shows them
// opens, since OPS_FEED_READS is pinned and the feed does not grow a read. Routes, not
// tools, so no grant is checked here (CLAUDE.md, one enforcement point rule): each
// answers to portalGate, and src/scope.ts lists them among the routes gated some other way.

export const PORTAL_PLAN_PATH = "/portal/api/plan";
export const PORTAL_DIGEST_PATH = "/portal/api/digest";

/** GET /portal/api/plan: what an overnight run would work, per repo, and what it skips. */
export async function handlePortalPlan(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const { for_namespace: _all, ...plan } = await readOvernightPlan(env, {}, now);
  const body: PortalPlan = plan;
  return json(body);
}

/** GET /portal/api/digest?since=: what finished, blocked and is ready since then. */
export async function handlePortalDigest(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const since = digestSinceFrom(new URL(request.url).searchParams.get("since") ?? undefined, now);
  if (!since.ok) return new Response(since.refusal, { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const body: PortalDigest = await readOvernightDigest(env, { since: since.since }, now);
  return json(body);
}
