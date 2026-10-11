import type { Env } from "./env";
import { OPS_RETURN_TO } from "./ops-feed";
import { portalGate } from "./portal-auth";
import { readTrends } from "./trends";

// The Portal's trends: GET /portal/api/trends?weeks= (design-portal-evaluation.md, DECIDE 5:
// "admin, read-only", ruled 2026-10-09). The series behind the charts, from src/trends.ts.
// A route, not a tool, so no grant is checked here (CLAUDE.md, one enforcement point rule):
// it answers to portalGate, and src/scope.ts lists it among the routes gated some other
// way. It writes only its own hour-long CI cache.

export const PORTAL_TRENDS_PATH = "/portal/api/trends";
const DEFAULT_WEEKS = 8;
const MAX_WEEKS = 26;

/** GET /portal/api/trends: every series, the weekly ones over ?weeks= (1 to 26, default 8). */
export async function handlePortalTrends(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
  const gate = await portalGate(request, env, now, OPS_RETURN_TO);
  if (!gate.ok) return gate.response;
  const raw = new URL(request.url).searchParams.get("weeks")?.trim();
  const weeks = raw ? Number(raw) : DEFAULT_WEEKS;
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_WEEKS) {
    return new Response(JSON.stringify({ error: `weeks must be a whole number from 1 to ${MAX_WEEKS}.` }), { status: 400, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  const body = await readTrends(env, now, weeks);
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
