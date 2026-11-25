import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { adminEmails } from "@dustinedwards/site-runtime/access";
import { adminGrantEmail } from "./auth";
import { adminAgentForEmail } from "./agents";
import { readLastStepUp } from "./scope";
import { CAPSID_JOBS, runCapsidJob } from "./site-jobs";
import { defaultHandler } from "./routes";
import { withSecurityHeaders } from "./security-headers";
import type { Env, Props } from "./env";
import { ADMIN_SERVER_INFO, buildAdminServer, buildServer, SERVER_INFO } from "./server";
import { ADMIN_MCP_ROUTE, mcpRateLimited, SCOPES, serveMcp } from "./mcp-handler";
import { audienceRefusal, mcpOriginRefusal } from "@dustinedwards/site-runtime/mcp-server";
import {
  DCR_CALLBACKS,
  registrationLimited,
  registrationRefusal,
} from "@dustinedwards/site-runtime/mcp-login";
import { runTick } from "./tick";
import { runTask, type TaskResult } from "./task-runs";
import { isPortalHost, portalHostRequest } from "./portal-host";
import { handlePortalDemo, isDemoRequest } from "./portal-demo";
import { portalAsset } from "./portal-app";
import { hostRefusal, MCP_HOST, MCP_URL } from "./mcp-host";
import { logEvent, withRequestLog } from "@dustinedwards/site-runtime/log";
import { withSiteSentry } from "@dustinedwards/site-runtime/sentry";
import { maintenanceOn, maintenanceResponse } from "@dustinedwards/site-runtime/maintenance";
import { countNotFound } from "@dustinedwards/site-runtime/not-found";
import { securityTxtResponse } from "@dustinedwards/site-runtime/security-txt";
import { robotsResponse } from "@drdustinedwards/site-helpers/robots";
import { ADMIN_LIST_PATH, adminListResponse } from "@dustinedwards/site-runtime/access-drift";

const SECURITY_TXT_PATH = "/.well-known/security.txt";
const SECURITY_TXT_EXPIRES = "2027-10-25T00:00:00Z";

export { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";
import { ToolCallLog as SharedToolCallLog } from "@dustinedwards/site-runtime/audit-log";
import { withAuditKey } from "./audit-key";

// The tool-call log with its signing key derived from COOKIE_ENCRYPTION_KEY (audit-key.ts).
export class ToolCallLog extends SharedToolCallLog {
  constructor(state: DurableObjectState, env: Env) {
    super(state, withAuditKey(env));
  }
}

export const BACKUP_CRON = "0 9 * * *";
export const TICK_CRON = "*/5 * * * *";

type ApiContext = ExecutionContext & {
  props?: Props;
  auth?: { scope?: string[]; clientId?: string; audience?: string };
};

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { props, auth } = ctx as ApiContext;
    const url = new URL(request.url);
    // The token must have been issued for this host's resource (RFC 8707), re-checked with the
    // family's shared check against the resource this host serves, not only the one the provider was
    // built with. Capsid Admin on /mcp/admin takes the /mcp token.
    const wrongAudience = audienceRefusal(auth, MCP_URL, [SCOPES.read]);
    if (wrongAudience) return wrongAudience;
    const adminRoute = url.pathname === ADMIN_MCP_ROUTE;
    const email = await adminGrantEmail(env, props);
    if (!email) {
      return new Response("forbidden: this grant does not belong to an administrator of capsid", {
        status: 403,
      });
    }
    const limited = await mcpRateLimited(
      env,
      `access:${email}`,
      adminRoute ? ADMIN_SERVER_INFO : SERVER_INFO,
    );
    if (limited) return limited;
    // The admin agent holds every scope the token does: every namespace, tool and flag, and the write
    // grant only when the consent page's box was ticked (capsid.write). The email Access verified is
    // the audit actor.
    const signedInAt = typeof props?.signed_in_at === "number" ? props.signed_in_at : null;
    const admin = adminAgentForEmail(email, signedInAt);
    if (!auth?.scope?.includes(SCOPES.write)) admin.scopes = { ...admin.scopes, grants: ["read"] };
    const clientId = auth?.clientId;
    const clientName = typeof props?.client === "string" && props.client ? props.client : undefined;
    if (adminRoute && signedInAt !== null)
      admin.lastStepUpAt = await readLastStepUp(env.APP_KV, admin.actor, signedInAt);
    // Capsid Admin on its own route: the eight administrator tools, never on /mcp. Only the
    // administrator's grant reaches this handler at all, and the step-up in src/scope.ts guards its
    // risky actions.
    if (adminRoute) {
      return serveMcp(request, env, ctx, ADMIN_MCP_ROUTE, () =>
        buildAdminServer(env, admin, "", clientId, clientName),
      );
    }
    return serveMcp(request, env, ctx, "/mcp", () =>
      buildServer(env, admin, "", clientId, clientName),
    );
  },
};

// Fail-closed: every response leaves with no-store unless it asked otherwise.
const CACHE_EXEMPT_PATHS = new Set(["/health"]);

function withCacheDefault(response: Response, pathname: string): Response {
  if (CACHE_EXEMPT_PATHS.has(pathname)) return response;
  if (response.headers.has("Cache-Control")) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// It is built once per registration allowlist, which is the env's: a changed DCR_REDIRECT_URIS
// gets a new provider, never a stale one.
const providers = new Map<string, OAuthProvider<Env>>();

function dcrAllowlist(env: Env): string {
  return [...DCR_CALLBACKS, env.DCR_REDIRECT_URIS ?? ""].join(",");
}

function providerFor(env: Env): OAuthProvider<Env> {
  // The callbacks every user shares (Grok, ChatGPT, Gemini) and the per-connector ones the seat
  // lists in DCR_REDIRECT_URIS, each matched exactly.
  const allowed = dcrAllowlist(env);
  let provider = providers.get(allowed);
  if (provider) return provider;
  provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    scopesSupported: SCOPES.all,
    requiredScopes: [SCOPES.read],
    resourceMetadata: { resource: MCP_URL, resource_name: "Capsid" },
    clientIdMetadataDocumentEnabled: true,
    // Tightened DCR for Grok and Gemini (rule 13): exact redirect URIs only, rate limited before the
    // provider sees it (default export below), and a registration grants nothing, since the consent
    // page and Access still decide.
    clientRegistrationEndpoint: "/register",
    clientRegistrationCallback: ({
      clientMetadata,
    }: {
      clientMetadata: Record<string, unknown>;
    }) => {
      const why = registrationRefusal(allowed, clientMetadata);
      if (!why) return undefined;
      // A refusal is the allowlist working: the client gets a 400, and the live gate's own
      // unlisted-redirect probe draws one on every deploy. Warn, as site-runtime logs every 4xx, so it
      // is in the logs but never a Sentry error report (CAPSID-1).
      logEvent(
        "DCR_REDIRECT_REFUSED",
        { message: `DCR_REDIRECT_REFUSED ${why}` },
        { level: "warn" },
      );
      return { code: "invalid_redirect_uri", description: why };
    },
  });
  providers.set(allowed, provider);
  return provider;
}

async function serve(original: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // It runs FIRST, before the OAuth provider, because the provider answers its own routes (/mcp,
  // /token, /authorize, /register, its metadata) without reaching the routes handler. Behind the
  // provider, /mcp on the Portal host would be taken as the MCP endpoint.
  const { hostname, pathname: asked } = new URL(original.url);
  const secured = (response: Response, path: string) =>
    withSecurityHeaders(withCacheDefault(response, path), original);
  if (maintenanceOn(env) && asked !== "/health")
    return secured(maintenanceResponse({ siteName: "Capsid" }), asked);
  if (asked === SECURITY_TXT_PATH)
    return secured(
      securityTxtResponse({
        origin: `https://${hostname}`,
        contact: "security@dustinedwards.info",
        expires: SECURITY_TXT_EXPIRES,
      }),
      asked,
    );
  if (asked === "/robots.txt" && hostname === MCP_HOST)
    return secured(
      robotsResponse({ origin: `https://${MCP_HOST}`, request: original, preview: true }),
      asked,
    );
  // The admin list, hashed with a fresh salt, for the daily Access drift check
  // (.github/workflows/access-drift.yml). adminListResponse answers only a GET with that
  // application's verified token from a service token, and 404 to everything else, so it runs before
  // the Portal's sign-in.
  if (asked === ADMIN_LIST_PATH && isPortalHost(new URL(original.url))) {
    const list = await adminListResponse(
      original,
      { ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN, ACCESS_AUD: env.ACCESS_DRIFT_AUD },
      { admins: adminEmails(env) },
    );
    return secured(list, asked);
  }
  if (isDemoRequest(new URL(original.url)))
    return secured(await handlePortalDemo(original, env), asked);
  const asset = await portalAsset(original, env);
  if (asset) return secured(asset, asked);
  const host = portalHostRequest(original);
  if ("redirect" in host) return secured(host.redirect, asked);
  const request = host.request;
  const pathname = new URL(request.url).pathname;
  const refused = hostRefusal(request);
  if (refused) return secured(refused, pathname);
  // Before the token check, so a page on another origin learns nothing from a 401 (DNS rebinding): a
  // missing Origin, this origin and claude.ai pass.
  if (pathname === "/mcp" || pathname === ADMIN_MCP_ROUTE) {
    const foreign = mcpOriginRefusal(request, ["https://claude.ai"]);
    if (foreign) return secured(foreign, pathname);
  }
  if (pathname === "/register" && request.method === "POST") {
    // A registration the allowlist refuses counts only per address, never toward the daily 30, so the
    // live gate's unlisted-redirect probe cannot spend it.
    const limited = await registrationLimited(request, env.OAUTH_KV, dcrAllowlist(env));
    if (limited) return secured(limited, pathname);
  }
  const response = await providerFor(env).fetch(request, env, ctx);
  return secured(
    pathname.startsWith(PRM_PATH) ? await withEveryScope(response) : response,
    pathname,
  );
}

// The protected resource metadata lists every scope the resource takes, read and write. that stays
// the read scope alone, so a client that follows the challenge meets the consent page with the
// write box unticked.
const PRM_PATH = "/.well-known/oauth-protected-resource";

async function withEveryScope(response: Response): Promise<Response> {
  if (!response.ok || !response.headers.get("Content-Type")?.includes("application/json"))
    return response;
  const metadata = (await response.json()) as Record<string, unknown>;
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  return Response.json(
    { ...metadata, scopes_supported: SCOPES.all },
    { status: response.status, headers },
  );
}

// Every request writes one `request` line (site-runtime withRequestLog: cf-ray, method, path
// without the query, status, ms, deployed sha), and a 404 to a GET is counted per path, referring
// host and UTC day in page_404_daily (site-runtime countNotFound, migrations/0053) in waitUntil,
// so it never holds the answer;
export default withSiteSentry({
  fetch: withRequestLog(
    async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
      const response = await serve(request, env, ctx);
      countNotFound(env.DB, request, response, ctx);
      return response;
    },
    { sha: (env: Env) => env.BUILD_SHA },
  ),
  // Each branch is its own task so a throwing tick cannot stop the backup. runTask
  // (src/task-runs.ts) records every run in the run ledger, logs a throw with the tag named here,
  // and rethrows it so the invocation shows as failed.
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const cron = controller.cron;
    // Every key wrangler.jsonc.example registers has a branch below. A key with none (a trigger added
    // in the dashboard, or one renamed here and not there) would run nothing silently, so it is logged
    // as an error.
    if (cron !== BACKUP_CRON && cron !== TICK_CRON) {
      logEvent(
        "CRON_KEY_UNKNOWN",
        { message: `CRON_KEY_UNKNOWN ${cron} has no task here; nothing ran` },
        { level: "error" },
      );
    }

    if (cron === BACKUP_CRON) {
      // Each its own task (src/site-jobs.ts CAPSID_JOBS, the list the run_job control runs now), so a
      // throw in one cannot stop the others: the dump under its lease, the tool-call log's daily copy to
      // AUDIT_BUCKET, and the supersede pass (design-hybrid-search 3.4).
      for (const job of CAPSID_JOBS) ctx.waitUntil(runCapsidJob(env, job, true));
    }

    if (cron === TICK_CRON) {
      ctx.waitUntil(
        runTask(
          env,
          "tick",
          // The tick's signed-in crawl asks serve() for the Portal's pages in-process
          // (src/signed-in-crawl.ts), past the request log and the 404 count, so a crawl is never recorded
          // as a visit.
          () => runTick(env, new Date(), (request) => serve(request, env, ctx)),
          (): TaskResult => ({
            outcome: "ok",
            reason: "the tick's steps ran; each records its own run",
          }),
          { tag: "TICK_THREW", rethrow: true },
        ),
      );
    }
  },
} satisfies ExportedHandler<Env>);
