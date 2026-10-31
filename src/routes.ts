import { handleSignedInReport, SIGNED_IN_REPORT_PATH } from "./signed-in-crawl";
import { PUBLIC_CODE_PATH, PUBLIC_DOCS, PUBLIC_MODEL_PATH, PUBLIC_STATS_PATH, handlePublicDocument } from "./public-data";
import { SHADOW_JOB_PATH, SHADOW_RESULT_PATH, handleShadowJob, handleShadowResult } from "./shadow";
import { BENCH_DRAW_PATH, BENCH_REPRO_PATH, BENCH_SCORE_PATH, BENCH_START_PATH, BENCH_TASKS_PATH, handleBenchDraw, handleBenchRepro, handleBenchScore, handleBenchStart, handleBenchTasks } from "./bench";
import { resolveAgent } from "./agents";
import { backupHttpStatus, runBackup } from "./backup";
import { checkScope, routeRefusal } from "./scope";
import { gatherInbox, restrictInbox } from "./inbox";
import { VERIFY_LIVE_CLIENT_PATH, handleClientDocument } from "./oauth-client-docs";
import { MAX_INBOX_REPORT_BYTES, REPORT_TTL_SECONDS, parseReport, reportCallerRefusal, spendReportRate, storeReport } from "./inbox-report";
import { readSiteConfig } from "./ops-sites";
import { consentDialogHeaders, REPORT_PATH, securityHeadersFor } from "./security-headers";
import { receiveCspReport } from "@dustinedwards/site-runtime/csp-report";
import { ipKey, limit } from "@dustinedwards/site-runtime/rate-limit";
import type { Env } from "./env";
import { ADMIN_SERVER_INFO, buildAdminServer, buildServer, SERVER_INFO } from "./server";
import { ADMIN_OPS_MCP_ROUTE, mcpRateLimited, SCOPES, serveMcp } from "./mcp-handler";
import { isAdminEmail } from "./auth";
import { loginHandler } from "@dustinedwards/site-runtime/mcp-login";
import {
  BACKUP_CREDENTIAL_PATH,
  claimJti,
  MAX_REPORT_BYTES,
  mintBackupCredential,
  parseBackupCredentialRequest,
  readBoundedText,
  verifyBackupCredentialRequest,
} from "./signed-requests";
import { handleHealth } from "./health";
import { handlePortalApp } from "./portal-app";
import { PORTAL_HOST } from "./portal-host";
import { OPS_FEED_PATH, OPS_REFRESH_PATH, handleOpsFeed, handleOpsRefresh } from "./ops-feed";
import { OTLP_LOGS_PATH, OTLP_METRICS_PATH, handleOtlpLogs, handleOtlpMetrics } from "./ops-otlp";
import { OPS_HOOKS_PATH, handleOpsHooks } from "./ops-hooks";
import {
  handlePortalActivity,
  handlePortalApiNotFound,
  handlePortalNamespaces,
  handlePortalPerform,
  handlePortalPreview,
  handlePortalSignOut,
  PORTAL_ACTIVITY_PATH,
  PORTAL_API_PREFIX,
  PORTAL_NAMESPACES_PATH,
  PORTAL_PERFORM_PATH,
  PORTAL_PREVIEW_PATH,
  PORTAL_SIGN_OUT_PATH,
} from "./portal-actions";
import { handlePortalCallback, PORTAL_CALLBACK_PATH, PORTAL_PATH, PORTAL_PREFIX, withPortalIdle } from "./portal-auth";
import { handlePortalClaims, PORTAL_CLAIMS_PATH } from "./portal-claims";
import { handlePortalStale, PORTAL_STALE_PATH } from "./portal-stale";
import { handlePortalDigest, handlePortalPlan, PORTAL_DIGEST_PATH, PORTAL_PLAN_PATH } from "./portal-overnight";
import { handlePortalMaintenance, PORTAL_MAINTENANCE_PATH } from "./portal-maintenance";
import { handlePortalConvergence, PORTAL_CONVERGENCE_PATH } from "./portal-convergence";
import { handlePortalPushGet, handlePortalPushPost, PORTAL_PUSH_PATH } from "./push";
import { handlePortalLibrary, PORTAL_LIBRARY_PATH } from "./portal-library";
import { handlePortalTrends, PORTAL_TRENDS_PATH } from "./portal-trends";
import { handlePortalCompleteness, handlePortalPackageHistory, handlePortalSharedCode, PORTAL_COMPLETENESS_PATH, PORTAL_PACKAGE_HISTORY_PATH, PORTAL_SHARED_CODE_PATH } from "./portal-packages";
import { logEvent } from "@dustinedwards/site-runtime/log";
import { rateLimiter, textResponse } from "./http";

// The MCP authorization flow (rule 13): site-runtime's consent page, the Access for SaaS
// round trip and the /callback, behind the OAuth provider. Capsid passes what is its own:
// who is admitted (ADMIN_EMAIL and every CO_OWNER_EMAILS entry, src/auth.ts), and the
// sign-in time its admin server's step-up reads (src/scope.ts STEP_UP), which joins the
// grant's props. Every grant reads; the write box adds capsid.write.
const login = loginHandler<Env>({
  name: "Capsid",
  scopes: SCOPES,
  about:
    "<p>Capsid serves the portfolio's knowledge base and reaches its GitHub repos. It will always be able to read. " +
    "Writing documents, changing repos, working jobs and Capsid Admin's controls need the box below.</p>",
  admit: async (env, user) => ((await isAdminEmail(env, user.email)) ? { signed_in_at: Date.now() } : false),
  admits: {
    consent: "Only Capsid's administrator and its co-owners are accepted.",
    refusal: "This account is not an administrator of Capsid (ADMIN_EMAIL or CO_OWNER_EMAILS).",
  },
  audit: { name: SERVER_INFO.name, version: SERVER_INFO.version },
  // Claude identifies both connectors, Capsid on /mcp and Capsid Admin on /mcp/admin, with
  // one client id (its CIMD document), so revoking earlier grants on each authorization
  // signed one out when the other signed in. Each grant still expires on its own.
  revokeExistingGrants: false,
});

// The consent page leaves with Capsid's own headers (consentDialogHeaders, and why its
// CSP has no form-action), which the header layer in src/index.ts leaves as they are.
async function handleLogin(request: Request, env: Env): Promise<Response> {
  const response = await login.fetch(request, env);
  if (!(response.headers.get("Content-Type") ?? "").includes("text/html")) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(await consentDialogHeaders())) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleOperatorMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // The bearer is resolved to a caller once, here, and every tool in this request is
  // checked against it. A minted agent carries the scopes its row says; a legacy
  // operator key resolves to the unrestricted caller until it is revoked by hand.
  const resolved = await resolveAgent(request, env);
  if (!resolved) {
    return new Response("unauthorized: valid operator key or agent key required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="capsid-operator"' },
    });
  }
  const limited = await mcpRateLimited(env, resolved.agent.actor, SERVER_INFO);
  if (limited) return limited;
  // last_seen is not part of authorizing, so a slow or failing write rides on
  // waitUntil rather than slowing the tool call.
  ctx.waitUntil(resolved.touch());
  return serveMcp(request, env, ctx, "/ops/mcp", () => buildServer(env, resolved.agent));
}

// Capsid Admin for a key (src/mcp-handler.ts ADMIN_OPS_MCP_ROUTE): the seat's scripts
// (scripts/mint-agents.ts) reach the administrator tools with its operator key. Only
// the admin identity is served; any other key is refused here, before a server is
// built, and every tool on it is admin only in the registrar as well.
async function handleOperatorAdminMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const resolved = await resolveAgent(request, env);
  if (!resolved) {
    return new Response("unauthorized: an admin operator key is required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="capsid-operator"' },
    });
  }
  if (!resolved.agent.admin) {
    return new Response(`forbidden: ${resolved.agent.actor} is not the admin. Capsid Admin serves the administrator alone.`, { status: 403 });
  }
  const limited = await mcpRateLimited(env, resolved.agent.actor, ADMIN_SERVER_INFO);
  if (limited) return limited;
  ctx.waitUntil(resolved.touch());
  return serveMcp(request, env, ctx, ADMIN_OPS_MCP_ROUTE, () => buildAdminServer(env, resolved.agent));
}

async function handleBackup(request: Request, env: Env): Promise<Response> {
  // No credential, or one that resolves to nobody: 401, so a client knows to send one.
  const caller = await resolveAgent(request, env);
  if (!caller) {
    return new Response("unauthorized: admin operator key required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="capsid-operator"' },
    });
  }
  // A caller that resolved but may not run this: 403. A backup and its prune cover
  // every namespace, so ROUTE_GRANTS in src/scope.ts requires the admin, through the
  // same checkScope the tools use. The write grant alone is held by every
  // namespace-scoped driver.
  const refusal = routeRefusal("/ops/backup", caller.agent);
  if (refusal) return new Response(refusal, { status: 403 });
  const result = await runBackup(env);
  return Response.json(result, { status: backupHttpStatus(result) });
}

// What needs Dustin, per app (src/inbox.ts), for the admin shell's app strip. It is read
// by each app's SERVER with a key, never by a browser: a browser on another admin host
// would need either a Portal session it does not hold or a secret in the page, and
// Cloudflare Access would stop the CORS preflight anyway. A key scoped to one namespace
// sees that app alone. The shell renders without badges when this fails, so a failure
// here is a plain error and never retried into a block.
async function handleInbox(request: Request, env: Env): Promise<Response> {
  const caller = await resolveAgent(request, env);
  if (!caller) {
    return new Response("unauthorized: an agent key or the operator key is required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="capsid-operator"' },
    });
  }
  const everything = await gatherInbox(env, new Date(), null);
  const readable = (namespace: string) => checkScope(caller.agent, { tool: "capsid_run_improve", action: "status", namespace, grant: "read" }) === null;
  return Response.json(restrictInbox(everything, readable), { headers: { "Cache-Control": "private, max-age=30" } });
}

// What an app reports about itself to the inbox (src/inbox-report.ts): the app's own
// key, the write grant on the namespace it names, one report per minute, the 6 hour
// expiry. The order is the gate's: who, then what, then the rate, then the write, so a
// refused report spends nothing.
async function handleInboxReport(request: Request, env: Env): Promise<Response> {
  const caller = await resolveAgent(request, env);
  if (!caller) return textResponse("unauthorized: the app's own agent key is required", 401, { "WWW-Authenticate": 'Bearer realm="capsid-operator"' });
  const bounded = await readBoundedText(request, MAX_INBOX_REPORT_BYTES);
  if (!bounded.ok) return textResponse(`request too large: exceeds ${MAX_INBOX_REPORT_BYTES} bytes`, 413);
  let body: unknown;
  try {
    body = JSON.parse(bounded.text);
  } catch {
    return textResponse("the body must be JSON", 400);
  }
  const namespace = (body as { namespace?: unknown } | null)?.namespace;
  if (typeof namespace !== "string" || namespace === "") return textResponse("namespace is required", 400);
  const refusal = reportCallerRefusal(caller.agent, namespace);
  if (refusal) return textResponse(refusal, 403);
  const now = new Date();
  const config = await readSiteConfig(env.DB);
  const origin = config.find((c) => c.namespace === namespace)?.origin ?? null;
  const parsed = parseReport(body, origin, now);
  if (!parsed.ok) return textResponse(parsed.refusal, 400);
  const rate = await spendReportRate(env.APP_KV, caller.agent.actor);
  if (!rate.ok) return textResponse(rate.refusal, rate.status, { "Retry-After": "60" });
  await storeReport(env.APP_KV, { namespace, reported_at: now.toISOString(), reported_by: caller.agent.actor, items: parsed.value.items });
  return Response.json({ ok: true, namespace, items: parsed.value.items.length, expires_in_seconds: REPORT_TTL_SECONDS }, { headers: { "Cache-Control": "no-store" } });
}

// Fail closed: /csp-report is unauthenticated and every accepted report writes log lines, so
// failing open would let anyone fill the logs during an outage. A dropped report costs one
// browser diagnostic, and the browser still gets its 204.
export const CSP_REPORT_RULES = [
  { limit: 300, windowSeconds: 3600 },
  { limit: 1000, windowSeconds: 86_400 },
];

// The family's one receiver (@dustinedwards/site-runtime/csp-report): a POST always
// gets 204, the body is read to 16 KB and no further, at most ten violations are
// logged one line each with every URL cut to origin and path, and nothing is stored.
// The limiter is asked first, and a refusal is a dropped report rather than a 429. Every method
// comes here, so a GET is the receiver's 405 as on the other sites, and the Portal's
// pages, which report here from their own host, get the preflight the Reporting API sends.
async function handleCspReport(request: Request, env: Env): Promise<Response> {
  return receiveCspReport(request, {
    allowOrigin: `https://${PORTAL_HOST}`,
    headers: securityHeadersFor(new URL(request.url).hostname),
    allow: async (r) => {
      const { key } = ipKey("csp-report", r);
      const verdict = await limit(rateLimiter(env), key, CSP_REPORT_RULES, { onUnavailable: "refuse" });
      if (verdict.status === "limited") {
        logEvent("CSP_REPORT_RATE_LIMITED", { message: `CSP_REPORT_RATE_LIMITED ${key} hit the ${verdict.window}s limit (${verdict.used} of ${verdict.limit})` }, { level: "error" });
      }
      return verdict.status === "ok";
    },
  });
}

// /health lives in src/health.ts: routes.ts pulls cloudflare:workers via the Agents
// SDK and cannot load under node --test.

async function readSignedBody(request: Request, tooLarge: string): Promise<{ ok: true; body: string } | { ok: false; response: Response }> {
  const bounded = await readBoundedText(request, MAX_REPORT_BYTES);
  if (!bounded.ok) return { ok: false, response: textResponse(tooLarge, 413) };
  return { ok: true, body: bounded.text };
}

// The backup-credential mint: an HMAC over timestamp.body with the backup-specific
// derived key, a bounded body and the jti replay cache, then one hour of
// object-read-only on backups/json/. The jti cache runs under the literal scope
// "backup", which is not in ROSTER.
async function handleBackupCredential(request: Request, env: Env): Promise<Response> {
  const timestamp = request.headers.get("X-Backup-Timestamp") ?? "";
  const signature = request.headers.get("X-Backup-Signature") ?? "";

  const bounded = await readSignedBody(request, `request too large: exceeds ${MAX_REPORT_BYTES} bytes`);
  if (!bounded.ok) return bounded.response;
  const body = bounded.body;

  const verdict = await verifyBackupCredentialRequest(env, { timestamp, signature, body }, new Date());
  if (!verdict.ok) {
    logEvent("BACKUP_CREDENTIAL_REJECTED", { message: `BACKUP_CREDENTIAL_REJECTED ${verdict.refusal}` }, { level: "error" });
    return textResponse(verdict.refusal, verdict.status);
  }

  const parsed = parseBackupCredentialRequest(body);
  if (!parsed.ok) return textResponse(parsed.refusal, 400);

  const claim = await claimJti(env.DB, "backup", parsed.jti);
  if (!claim.ok) return textResponse(claim.refusal, claim.status);

  const minted = await mintBackupCredential(env, parsed.site);
  if (!minted.ok) {
    logEvent("BACKUP_CREDENTIAL_FAILED", { message: `BACKUP_CREDENTIAL_FAILED site=${parsed.site} ${minted.refusal}` }, { level: "error" });
    return textResponse(minted.refusal, minted.status);
  }
  logEvent("BACKUP_CREDENTIAL_MINTED", { message: `BACKUP_CREDENTIAL_MINTED site=${parsed.site} ttl=${minted.credential.expires_in}s` });
  return new Response(JSON.stringify(minted.credential), { status: 200, headers: { "Content-Type": "application/json" } });
}

export const defaultHandler = {
  async fetch(original: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The Portal host's rewrite has already run, in src/index.ts, before the OAuth
    // provider: a request here for portal.dustinedwards.info is already a /portal path.
    const request = original;
    const url = new URL(request.url);
    if (url.pathname === "/health") return handleHealth(env);
    if (url.pathname === SIGNED_IN_REPORT_PATH && request.method === "GET") return handleSignedInReport(env);
    if (url.pathname === PUBLIC_MODEL_PATH && request.method === "GET") return handlePublicDocument(request, env, ctx, PUBLIC_DOCS.model);
    if (url.pathname === PUBLIC_STATS_PATH && request.method === "GET") return handlePublicDocument(request, env, ctx, PUBLIC_DOCS.stats);
    if (url.pathname === PUBLIC_CODE_PATH && request.method === "GET") return handlePublicDocument(request, env, ctx, PUBLIC_DOCS.code);
    if (url.pathname === VERIFY_LIVE_CLIENT_PATH && request.method === "GET") return handleClientDocument(request);
    if (url.pathname === REPORT_PATH) return handleCspReport(request, env);
    if (url.pathname === "/ops/mcp") return handleOperatorMcp(request, env, ctx);
    if (url.pathname === ADMIN_OPS_MCP_ROUTE) return handleOperatorAdminMcp(request, env, ctx);
    if (url.pathname === "/ops/backup" && request.method === "POST") return handleBackup(request, env);
    if (url.pathname === "/ops/inbox" && request.method === "GET") return handleInbox(request, env);
    if (url.pathname === "/ops/inbox/report" && request.method === "POST") return handleInboxReport(request, env);
    if (url.pathname === OPS_HOOKS_PATH && request.method === "POST") return handleOpsHooks(request, env, ctx);
    if (url.pathname === OTLP_METRICS_PATH && request.method === "POST") return handleOtlpMetrics(request, env);
    if (url.pathname === OTLP_LOGS_PATH && request.method === "POST") return handleOtlpLogs(request, env);
    if (url.pathname === BACKUP_CREDENTIAL_PATH && request.method === "POST") return handleBackupCredential(request, env);
    if (url.pathname === BENCH_TASKS_PATH && request.method === "POST") return handleBenchTasks(request, env);
    if (url.pathname === BENCH_DRAW_PATH && request.method === "POST") return handleBenchDraw(request, env);
    if (url.pathname === BENCH_START_PATH && request.method === "POST") return handleBenchStart(request, env);
    if (url.pathname === BENCH_REPRO_PATH && request.method === "POST") return handleBenchRepro(request, env);
    if (url.pathname === BENCH_SCORE_PATH && request.method === "POST") return handleBenchScore(request, env);
    if (url.pathname === SHADOW_JOB_PATH && request.method === "GET") return handleShadowJob(request, env);
    if (url.pathname === SHADOW_RESULT_PATH && request.method === "POST") return handleShadowResult(request, env);
    if (url.pathname === "/authorize") return handleLogin(request, env);
    if (url.pathname === "/callback") return handleLogin(request, env);
    // Capsid Portal. The callback and every /portal/api/ route are matched before the
    // app's catch-all, and an unknown /portal/api/ path is a 404, never the app's page.
    // Nothing answers under /console: the Portal moved without redirects
    // (capsid/research/design-portal-unify.md), so an old address reaches the 404 below.
    if (url.pathname === PORTAL_CALLBACK_PATH) return handlePortalCallback(request, env, new Date());
    // Every other Portal route goes through the shared idle hour (withPortalIdle, src/portal-auth.ts).
    if (url.pathname === PORTAL_PATH || url.pathname.startsWith(PORTAL_PREFIX)) return withPortalIdle(request, env, () => portalRoute(request, env, url));

    return new Response("not found", { status: 404 });
  },
};

// The Portal's routes behind its callback: every /portal/api/ route is matched before
// the app's catch-all, and an unknown /portal/api/ path is a 404, never the app's page.
function portalRoute(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === OPS_FEED_PATH && request.method === "GET") return handleOpsFeed(request, env);
  if (url.pathname === OPS_REFRESH_PATH && request.method === "POST") return handleOpsRefresh(request, env);
  if (url.pathname === PORTAL_PREVIEW_PATH && request.method === "POST") return handlePortalPreview(request, env);
  if (url.pathname === PORTAL_PERFORM_PATH && request.method === "POST") return handlePortalPerform(request, env);
  if (url.pathname === PORTAL_NAMESPACES_PATH && request.method === "GET") return handlePortalNamespaces(request, env);
  if (url.pathname === PORTAL_ACTIVITY_PATH && request.method === "GET") return handlePortalActivity(request, env);
  if (url.pathname === PORTAL_CLAIMS_PATH && request.method === "GET") return handlePortalClaims(request, env);
  if (url.pathname === PORTAL_STALE_PATH && request.method === "GET") return handlePortalStale(request, env);
  if (url.pathname === PORTAL_PLAN_PATH && request.method === "GET") return handlePortalPlan(request, env);
  if (url.pathname === PORTAL_DIGEST_PATH && request.method === "GET") return handlePortalDigest(request, env);
  if (url.pathname === PORTAL_MAINTENANCE_PATH && request.method === "GET") return handlePortalMaintenance(request, env);
  if (url.pathname === PORTAL_CONVERGENCE_PATH && request.method === "GET") return handlePortalConvergence(request, env);
  if (url.pathname === PORTAL_PACKAGE_HISTORY_PATH && request.method === "GET") return handlePortalPackageHistory(request, env);
  if (url.pathname === PORTAL_SHARED_CODE_PATH && request.method === "GET") return handlePortalSharedCode(request, env);
  if (url.pathname === PORTAL_COMPLETENESS_PATH && request.method === "GET") return handlePortalCompleteness(request, env);
  if (url.pathname === PORTAL_LIBRARY_PATH && request.method === "GET") return handlePortalLibrary(request, env);
  if (url.pathname === PORTAL_TRENDS_PATH && request.method === "GET") return handlePortalTrends(request, env);
  if (url.pathname === PORTAL_PUSH_PATH && request.method === "GET") return handlePortalPushGet(request, env);
  if (url.pathname === PORTAL_PUSH_PATH && request.method === "POST") return handlePortalPushPost(request, env);
  if (url.pathname === PORTAL_SIGN_OUT_PATH && request.method === "POST") return handlePortalSignOut(request, env);
  if (url.pathname.startsWith(PORTAL_API_PREFIX)) return handlePortalApiNotFound(request, env);
  // The app and everything under it, every method: the handler gates first.
  return handlePortalApp(request, env);
}
