import { PUBLIC_CODE_PATH, PUBLIC_DOCS, PUBLIC_MODEL_PATH, PUBLIC_STATS_PATH, handlePublicDocument } from "./public-data";
import { SHADOW_JOB_PATH, SHADOW_RESULT_PATH, handleShadowJob, handleShadowResult } from "./shadow";
import { BENCH_DRAW_PATH, BENCH_REPRO_PATH, BENCH_SCORE_PATH, BENCH_START_PATH, BENCH_TASKS_PATH, handleBenchDraw, handleBenchRepro, handleBenchScore, handleBenchStart, handleBenchTasks } from "./bench";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { getCookie } from "./auth";
import { safeEqual } from "@dustinedwards/site-runtime/compare";
import { resolveAgent } from "./agents";
import { backupHttpStatus, runBackup } from "./backup";
import { checkScope, routeRefusal } from "./scope";
import { gatherInbox, restrictInbox } from "./inbox";
import { VERIFY_LIVE_CLIENT_PATH, handleClientDocument } from "./oauth-client-docs";
import { MAX_INBOX_REPORT_BYTES, REPORT_TTL_SECONDS, parseReport, reportCallerRefusal, spendReportRate, storeReport } from "./inbox-report";
import { readSiteConfig } from "./ops-sites";
import { CONSENT_DIALOG_HEADERS, REPORT_PATH, securityHeadersFor } from "./security-headers";
import { receiveCspReport } from "@dustinedwards/site-runtime/csp-report";
import { callerIp, checkRate, CSP_REPORT_LIMIT } from "./rate-limit";
import type { Env, Props } from "./env";
import { buildAdminServer, buildServer } from "./server";
import { ADMIN_OPS_MCP_ROUTE, serveMcp } from "./mcp-handler";
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
import { escapeHtml } from "@dustinedwards/site-runtime/html";
import { handlePortalApp } from "./portal-app";
import { PORTAL_HOST } from "./portal-host";
import { OPS_FEED_PATH, OPS_REFRESH_PATH, handleOpsFeed, handleOpsRefresh } from "./ops-feed";
import { OTLP_LOGS_PATH, OTLP_METRICS_PATH, handleOtlpLogs, handleOtlpMetrics } from "./ops-otlp";
import { OPS_HOOKS_PATH, handleOpsHooks } from "./ops-hooks";
import { ACCESS_SYNC_PATH, handleAccessSync } from "./access-sync";
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
import { handlePortalCallback, PORTAL_CALLBACK_PATH, PORTAL_PATH, PORTAL_PREFIX } from "./portal-auth";
import { handlePortalClaims, PORTAL_CLAIMS_PATH } from "./portal-claims";
import { handlePortalStale, PORTAL_STALE_PATH } from "./portal-stale";
import { handlePortalDigest, handlePortalPlan, PORTAL_DIGEST_PATH, PORTAL_PLAN_PATH } from "./portal-overnight";
import { handlePortalMaintenance, PORTAL_MAINTENANCE_PATH } from "./portal-maintenance";
import { handlePortalConvergence, PORTAL_CONVERGENCE_PATH } from "./portal-convergence";
import { handlePortalPushGet, handlePortalPushPost, PORTAL_PUSH_PATH } from "./push";
import { handlePortalLibrary, PORTAL_LIBRARY_PATH } from "./portal-library";
import { handlePortalTrends, PORTAL_TRENDS_PATH } from "./portal-trends";
import { handlePortalPackageHistory, handlePortalSharedCode, PORTAL_PACKAGE_HISTORY_PATH, PORTAL_SHARED_CODE_PATH } from "./portal-packages";
import { clearStateCookie, completeAccessLogin, type LoginFlow, STATE_TTL_SECONDS, startAccessLogin } from "./access-login";
import { logEvent } from "@dustinedwards/site-runtime/log";
import { textResponse } from "./http";
import { base64url, fromBase64url } from "@dustinedwards/site-runtime/encoding";

const decodeBase64url = (text: string): string => new TextDecoder().decode(fromBase64url(text));

const CSRF_COOKIE = "capsid_csrf";

// The MCP authorization flow's sign-in, through Cloudflare Access for SaaS
// (src/access-login.ts). The state stored against the token is the JSON AuthRequest.
const MCP_LOGIN: LoginFlow = {
  callbackPath: "/callback",
  stateCookie: "capsid_state",
  cookiePath: "/callback",
  kvPrefix: "capsid:oauth-state:",
  restartHint: "Restart from your MCP client.",
};

function renderApprovalDialog(oauthReq: AuthRequest, clientName: string, csrf: string, registeredUris: string[] | undefined): Response {
  const name = escapeHtml(clientName);
  const redirect = escapeHtml(oauthReq.redirectUri);
  const req = base64url(JSON.stringify(oauthReq));
  // Every registered redirect URI is shown, not just the requested one. A client's
  // metadata document may name several and the approval covers only the requested
  // one, so listing the rest is what shows the admin that a client with a familiar
  // name also carries an attacker's redirect.
  const others = (registeredUris ?? []).filter((u) => u !== oauthReq.redirectUri);
  // A loopback callback hands the access to an app on this computer, as site-runtime's
  // mcp-login consent page warns.
  const host = new URL(oauthReq.redirectUri).hostname;
  const loopback = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(host)
    ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>\n"
    : "";
  const othersHtml = others.length
    ? `<p>This client also has these registered redirect URIs (not covered by this approval):</p><ul>${others
        .map((u) => `<li><code>${escapeHtml(u)}</code></li>`)
        .join("")}</ul>`
    : "";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a; }
.card { border: 1px solid #ddd; border-radius: 8px; padding: 1.5rem; }
code { background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 4px; word-break: break-all; }
button { background: #1a7f37; color: #fff; border: 0; border-radius: 6px; padding: 0.6rem 1.4rem; font-size: 1rem; cursor: pointer; }
</style>
</head>
<body>
<div class="card">
<h1>Capsid access request</h1>
<p><strong>${name}</strong> is asking to connect to this MCP server.</p>
<p>Requested redirect URI: <code>${redirect}</code></p>
${loopback}${othersHtml}
<p>Next you sign in with Cloudflare Access. Only the administrator and the co-owners are admitted.</p>
<form method="post" action="/authorize">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="req" value="${req}">
<button type="submit">Continue to sign in</button>
</form>
</div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      // The static headers, and why form-action is absent from the CSP: see
      // CONSENT_DIALOG_HEADERS in ./security-headers.
      ...CONSENT_DIALOG_HEADERS,
      "Set-Cookie": `${CSRF_COOKIE}=${csrf}; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=${STATE_TTL_SECONDS}`,
    },
  });
}

async function handleAuthorizeGet(request: Request, env: Env): Promise<Response> {
  let oauthReq: AuthRequest;
  try {
    oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (err) {
    return textResponse(`invalid authorization request: ${err instanceof Error ? err.message : String(err)}`, 400);
  }
  if (!oauthReq.clientId) return textResponse("invalid authorization request: missing client_id", 400);
  // Every authorization shows the dialog: nothing remembers an approval, so a later grant
  // to the same client is a decision of its own (checklist H5).
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId);
  if (!client) return textResponse("unknown client", 400);
  return renderApprovalDialog(oauthReq, client.clientName ?? oauthReq.clientId, crypto.randomUUID(), client.redirectUris);
}

// The consent form's body cap. `req` is a base64url AuthRequest and `csrf` a uuid, so
// a real submission is well under a kilobyte; 64KB leaves headroom and still refuses
// a body that is trying to be something else.
const AUTHORIZE_FORM_MAX_BYTES = 65_536;

async function handleAuthorizePost(request: Request, env: Env): Promise<Response> {
  // Bounded at the stream, before the parse. request.formData() buffers and parses
  // the whole body before any check here runs, on a path reachable without
  // credentials: the CSRF cookie is checked after the parse, and a caller can fetch
  // the form to obtain one.
  const bounded = await readBoundedText(request, AUTHORIZE_FORM_MAX_BYTES);
  if (!bounded.ok) return new Response(null, { status: 413 });
  // URLSearchParams, not formData(): the dialog is a plain `<form method="post">` with
  // no enctype, so the browser sends urlencoded, and so does the live gate.
  const form = new URLSearchParams(bounded.text);
  const csrf = form.get("csrf");
  const req = form.get("req");
  if (typeof csrf !== "string" || typeof req !== "string") return textResponse("bad request", 400);
  const csrfCookie = getCookie(request, CSRF_COOKIE);
  if (!csrfCookie || !await safeEqual(csrfCookie, csrf)) return textResponse("csrf validation failed: restart the flow", 403);
  let oauthReq: AuthRequest;
  try {
    oauthReq = JSON.parse(decodeBase64url(req)) as AuthRequest;
  } catch {
    return textResponse("bad request", 400);
  }
  const client = oauthReq.clientId ? await env.OAUTH_PROVIDER.lookupClient(oauthReq.clientId) : null;
  if (!client) return textResponse("unknown client", 400);
  const clearCsrf = `${CSRF_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=0`;
  return startAccessLogin(request, env, MCP_LOGIN, JSON.stringify(oauthReq), [clearCsrf]);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const login = await completeAccessLogin(request, env, MCP_LOGIN, (stored) => JSON.parse(stored) as AuthRequest);
  if (!login.ok) return login.response;
  const { email, state: oauthReq } = login;

  const props: Props = { email, signed_in_at: Date.now() };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: email,
    metadata: { email },
    scope: oauthReq.scope,
    props,
    // Claude identifies both connectors, Capsid on /mcp and Capsid Admin on /mcp/admin,
    // with one client id (its CIMD document). The provider's default revokes every
    // earlier grant for the same user and client on each authorization, so signing into
    // one connector signed the other out. Each grant still expires on its own.
    revokeExistingGrants: false,
  });

  const headers = new Headers({ Location: redirectTo });
  headers.append("Set-Cookie", clearStateCookie(MCP_LOGIN));
  return new Response(null, { status: 302, headers });
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
  return Response.json(restrictInbox(everything, readable), { headers: { "Cache-Control": "private, max-age=30", "X-Content-Type-Options": "nosniff" } });
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

// The family's one receiver (@dustinedwards/site-runtime/csp-report): a POST always
// gets 204, the body is read to 16 KB and no further, at most ten violations are
// logged one line each with every URL cut to origin and path, and nothing is stored.
// The limiter is asked first, and a refusal is a dropped report rather than a 429. Every method
// comes here, so a GET is the receiver's 405 as on the other sites, and the Portal's
// pages, which report here from their own host, get the preflight the Reporting API sends.
async function handleCspReport(request: Request, env: Env): Promise<Response> {
  return receiveCspReport(request, {
    allowOrigin: `https://${PORTAL_HOST}`,
    headers: securityHeadersFor("other"),
    allow: async (r) => {
      const ip = callerIp(r);
      const rate = await checkRate(env.APP_KV, ip, new Date(), CSP_REPORT_LIMIT);
      // The unavailable refusal has already logged itself.
      if (!rate.allowed && rate.window !== "unavailable") {
        logEvent("CSP_REPORT_RATE_LIMITED", { message: `CSP_REPORT_RATE_LIMITED ${ip} hit the ${rate.window} limit (${rate.count} of ${rate.limit})` }, { level: "error" });
      }
      return rate.allowed;
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
    if (url.pathname === ACCESS_SYNC_PATH && request.method === "POST") return handleAccessSync(request, env);
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
    if (url.pathname === "/authorize" && request.method === "GET") return handleAuthorizeGet(request, env);
    if (url.pathname === "/authorize" && request.method === "POST") return handleAuthorizePost(request, env);
    if (url.pathname === "/callback") return handleCallback(request, env);
    // Capsid Portal. The callback and every /portal/api/ route are matched before the
    // app's catch-all, and an unknown /portal/api/ path is a 404, never the app's page.
    // Nothing answers under /console: the Portal moved without redirects
    // (capsid/research/design-portal-unify.md), so an old address reaches the 404 below.
    if (url.pathname === PORTAL_CALLBACK_PATH) return handlePortalCallback(request, env, new Date());
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
    if (url.pathname === PORTAL_LIBRARY_PATH && request.method === "GET") return handlePortalLibrary(request, env);
    if (url.pathname === PORTAL_TRENDS_PATH && request.method === "GET") return handlePortalTrends(request, env);
    if (url.pathname === PORTAL_PUSH_PATH && request.method === "GET") return handlePortalPushGet(request, env);
    if (url.pathname === PORTAL_PUSH_PATH && request.method === "POST") return handlePortalPushPost(request, env);
    if (url.pathname === PORTAL_SIGN_OUT_PATH && request.method === "POST") return handlePortalSignOut(request, env);
    if (url.pathname.startsWith(PORTAL_API_PREFIX)) return handlePortalApiNotFound(request, env);
    // The app and everything under it, every method: the handler gates first.
    if (url.pathname === PORTAL_PATH || url.pathname.startsWith(PORTAL_PREFIX)) return handlePortalApp(request, env);

    return new Response("not found", { status: 404 });
  },
};
