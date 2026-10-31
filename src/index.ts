import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { adminGrantEmail } from "./auth";
import { adminAgentForEmail } from "./agents";
import { readLastStepUp } from "./scope";
import { adminWriteObserver, recordAdminInitialize } from "./admin-client-audit";
import { runBackup } from "./backup";
import { supersedePass } from "./supersede";
import { defaultHandler } from "./routes";
import { withSecurityHeaders } from "./security-headers";
import type { Env, Props } from "./env";
import { ADMIN_SERVER_INFO, buildAdminServer, buildServer, SERVER_INFO } from "./server";
import { ADMIN_MCP_ROUTE, mcpRateLimited, SCOPES, serveMcp } from "./mcp-handler";
import { audienceRefusal, mcpOriginRefusal } from "@dustinedwards/site-runtime/mcp-server";
import { DCR_CALLBACKS, registrationLimited, registrationRefusal } from "@dustinedwards/site-runtime/mcp-login";
import { runTick } from "./tick";
import { NOT_ITS_DAY, runSkillsRefresh } from "./skills-refresh";
import { runTask, type TaskResult } from "./task-runs";
import { portalHostRequest } from "./portal-host";
import { hostRefusal, LEGACY_HOST, LEGACY_MCP_URL, MCP_URL } from "./mcp-host";
import { logEvent, withRequestLog } from "@dustinedwards/site-runtime/log";
import { countNotFound } from "@dustinedwards/site-runtime/not-found";
import { securityTxtResponse } from "@dustinedwards/site-runtime/security-txt";

const SECURITY_TXT_PATH = "/.well-known/security.txt";
// Under a year out (RFC 9116); the family check reminds a month ahead.
const SECURITY_TXT_EXPIRES = "2027-10-25T00:00:00Z";

// The Durable Objects wrangler.jsonc binds (RATE_LIMITER, TOOL_CALL_LOG), from site-runtime.
export { RateLimiter } from "@dustinedwards/site-runtime/rate-limit/durable-object";
export { ToolCallLog } from "@dustinedwards/site-runtime/audit-log";

// Spelled once. wrangler.jsonc declares them; test/crons.test.ts derives one list
// from the other and fails in both directions.
export const BACKUP_CRON = "0 9 * * *";
export const TICK_CRON = "*/5 * * * *";
// Fires daily; readSchedule decides from KV whether today is the configured day, so
// the weekly schedule changes without a redeploy.
export const SKILLS_REFRESH_CRON = "30 9 * * *";

// What the OAuth provider hands its API handler: the grant's props, and what it verified
// about the token, its scopes among them.
type ApiContext = ExecutionContext & { props?: Props; auth?: { scope?: string[]; clientId?: string; audience?: string } };

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { props, auth } = ctx as ApiContext;
    const url = new URL(request.url);
    // The token must have been issued for this host's resource (RFC 8707), re-checked with
    // the family's shared check against the resource this host serves, not only the one the
    // provider was built with (area 11, A5). Capsid Admin on /mcp/admin takes the /mcp token.
    const wrongAudience = audienceRefusal(auth, url.hostname === LEGACY_HOST ? LEGACY_MCP_URL : MCP_URL, [SCOPES.read]);
    if (wrongAudience) return wrongAudience;
    const adminRoute = url.pathname === ADMIN_MCP_ROUTE;
    // Checked on every request, not only at sign-in (src/auth.ts adminGrantEmail).
    const email = await adminGrantEmail(env, props);
    if (!email) {
      return new Response("forbidden: this grant does not belong to an administrator of capsid", {
        status: 403,
      });
    }
    const limited = await mcpRateLimited(env, `access:${email}`, adminRoute ? ADMIN_SERVER_INFO : SERVER_INFO);
    if (limited) return limited;
    // The admin agent holds every scope the token does: every namespace, tool and flag,
    // and the write grant only when the consent page's box was ticked (capsid.write). A
    // grant from before the scopes existed carries neither, and reads until its client
    // signs in again. The email Access verified is the audit actor.
    const signedInAt = typeof props?.signed_in_at === "number" ? props.signed_in_at : null;
    const admin = adminAgentForEmail(email, signedInAt);
    if (!auth?.scope?.includes(SCOPES.write)) admin.scopes = { ...admin.scopes, grants: ["read"] };
    const clientId = auth?.clientId;
    // Only Capsid Admin serves step-up actions, so only its route reads the clock. A KV
    // failure leaves it undefined, which falls back to the sign-in time alone (src/scope.ts STEP_UP).
    if (adminRoute && signedInAt !== null) admin.lastStepUpAt = await readLastStepUp(env.APP_KV, admin.actor, signedInAt);
    // Observation only, for 30 days (src/admin-client-audit.ts): which client the admin
    // acts through. It never refuses on what the client says.
    await recordAdminInitialize(env.DB, admin.actor, request);
    const observe = adminWriteObserver(env.DB, admin.actor, request.headers.get("User-Agent"));
    // Capsid Admin on its own route: the eight administrator tools, never on /mcp. Only the administrator's grant
    // reaches this handler at all, and the step-up in src/scope.ts guards its risky actions.
    if (adminRoute) {
      return serveMcp(request, env, ctx, ADMIN_MCP_ROUTE, () => buildAdminServer(env, admin, "", observe, clientId));
    }
    return serveMcp(request, env, ctx, "/mcp", () => buildServer(env, admin, "", observe, clientId));
  },
};

// Fail-closed: every response leaves with no-store unless it asked otherwise.
const CACHE_EXEMPT_PATHS = new Set(["/health"]);

function withCacheDefault(response: Response, pathname: string): Response {
  if (CACHE_EXEMPT_PATHS.has(pathname)) return response;
  if (response.headers.has("Cache-Control")) return response;
  // Headers on an already-constructed Response can be immutable, so rebuild.
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// The RFC 8707 resource is per host. workers-oauth-provider binds every access token to
// ONE configured resource and refuses a token whose audience origin is not the host the
// request arrived on (token_audience_unbound, audience_mismatch), so one provider cannot
// serve /mcp on two hosts. The MCP endpoint lives at MCP_URL; the old address keeps its
// own provider only for the hours of the same-day cut (job_2f9671f89e89), so the
// claude.ai connector, authorized there, works until it is switched. Both share OAUTH_KV.
// The step that turns workers.dev off removes the legacy one.
//
// Each is built once per registration allowlist, which is the env's: a changed
// DCR_REDIRECT_URIS gets a new provider, never a stale one.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(env: Env, resource: string, registration: boolean): OAuthProvider<Env> {
  // The callbacks every user shares (Grok, ChatGPT, Gemini) and the per-connector ones the
  // seat lists in DCR_REDIRECT_URIS, each matched exactly.
  const allowed = [...DCR_CALLBACKS, env.DCR_REDIRECT_URIS ?? ""].join(",");
  const key = `${resource} ${registration} ${allowed}`;
  let provider = providers.get(key);
  if (provider) return provider;
  provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    // The read scope is what a client asks for first (the 401's scope= and the protected
    // resource metadata's scopes_supported); write is added on the consent page.
    scopesSupported: SCOPES.all,
    requiredScopes: [SCOPES.read],
    resourceMetadata: { resource, resource_name: "Capsid" },
    // CIMD first (capsid/mcp-wrapper-standard.md, amendment 2026-09-27): a client's id is
    // the URL of its metadata document. The provider advertises CIMD only while the
    // global_fetch_strictly_public compatibility flag is set (wrangler.jsonc.example).
    clientIdMetadataDocumentEnabled: true,
    // Tightened DCR for Grok and Gemini, on the MCP host only (rule 13): exact redirect
    // URIs only, rate limited before the provider sees it (default export below), and a
    // registration grants nothing, since the consent page and Access still decide. Remove
    // when both sign in by CIMD, at the latest when the specification removes DCR. The old
    // address keeps none; it is going.
    ...(registration
      ? {
          clientRegistrationEndpoint: "/register",
          clientRegistrationCallback: ({ clientMetadata }: { clientMetadata: Record<string, unknown> }) => {
            const why = registrationRefusal(allowed, clientMetadata);
            if (!why) return undefined;
            logEvent("DCR_REDIRECT_REFUSED", { message: `DCR_REDIRECT_REFUSED ${why}` }, { level: "error" });
            return { code: "invalid_redirect_uri", description: why };
          },
        }
      : {}),
  });
  providers.set(key, provider);
  return provider;
}

async function serve(original: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // portal.dustinedwards.info serves the Portal and nothing else (src/portal-host.ts):
  // /x there is /portal/x here, and an old /portal address redirects to the root. It
  // runs FIRST, before the OAuth provider, because the provider answers its own routes
  // (/mcp, /token, /authorize, /register, its metadata) without reaching the routes
  // handler. Behind the provider, /mcp on the Portal host was the MCP endpoint, and
  // live gate 7 rolled #218's deploy back (run 36863432268).
  const { hostname, pathname: asked } = new URL(original.url);
  const secured = (response: Response, path: string) => withSecurityHeaders(withCacheDefault(response, path), hostname);
  // security.txt on both hosts, before the Portal's sign-in and the MCP host's path list.
  if (asked === SECURITY_TXT_PATH) return secured(securityTxtResponse({ origin: `https://${hostname}`, contact: "security@dustinedwards.info", expires: SECURITY_TXT_EXPIRES }), asked);
  const host = portalHostRequest(original);
  if ("redirect" in host) return secured(host.redirect, asked);
  const request = host.request;
  // The MCP host serves the machine surface only, and the old address's /portal is
  // retired (src/mcp-host.ts). Also before the provider, for the same reason.
  const pathname = new URL(request.url).pathname;
  const refused = hostRefusal(request);
  if (refused) return secured(refused, pathname);
  // Before the token check, so a page on another origin learns nothing from a 401 (DNS
  // rebinding): a missing Origin, this origin and claude.ai pass.
  if (pathname === "/mcp" || pathname === ADMIN_MCP_ROUTE) {
    const foreign = mcpOriginRefusal(request, ["https://claude.ai"]);
    if (foreign) return secured(foreign, pathname);
  }
  const legacy = new URL(request.url).hostname === LEGACY_HOST;
  if (!legacy && pathname === "/register" && request.method === "POST") {
    const limited = await registrationLimited(request, env.OAUTH_KV);
    if (limited) return secured(limited, pathname);
  }
  const response = await providerFor(env, legacy ? LEGACY_MCP_URL : MCP_URL, !legacy).fetch(request, env, ctx);
  return secured(pathname.startsWith(PRM_PATH) ? await withEveryScope(response) : response, pathname);
}

// The protected resource metadata lists every scope the resource takes (area 11, A1), read
// and write. The provider publishes its requiredScopes there, which are also the 401's
// scope=, the least a client asks for first; that stays the read scope alone, so a client
// that follows the challenge meets the consent page with the write box unticked.
const PRM_PATH = "/.well-known/oauth-protected-resource";

async function withEveryScope(response: Response): Promise<Response> {
  if (!response.ok || !response.headers.get("Content-Type")?.includes("application/json")) return response;
  const metadata = (await response.json()) as Record<string, unknown>;
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  return Response.json({ ...metadata, scopes_supported: SCOPES.all }, { status: response.status, headers });
}

// Every request writes one `request` line (site-runtime withRequestLog: cf-ray, method, path
// without the query, status, ms and the deployed sha; area 8, L3), and a 404 to a GET is
// counted per path, referring host and UTC day in page_404_daily (site-runtime
// countNotFound, migrations/0053; area 8, N1), written in waitUntil so it never holds the
// answer. The backup prunes the counts at 90 days (src/backup.ts).
export default {
  fetch: withRequestLog(
    async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
      const response = await serve(request, env, ctx);
      countNotFound(env.DB, request, response, ctx);
      return response;
    },
    { sha: (env: Env) => env.BUILD_SHA }
  ),
  // Dispatch on controller.cron, not the clock: 09:00 UTC matches all three
  // expressions and Cloudflare delivers once per expression. Each branch is its own
  // task so a throwing tick cannot stop the backup. runTask (src/task-runs.ts) records every run in the
  // run ledger, logs a throw with the tag named here, and rethrows it so the
  // invocation shows as failed.
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const cron = controller.cron;
    // Every key wrangler.jsonc.example registers has a branch below. A key with none (a
    // trigger added in the dashboard, or one renamed here and not there) would run nothing
    // silently, so it is logged as an error (area 8, C2).
    if (cron !== BACKUP_CRON && cron !== TICK_CRON && cron !== SKILLS_REFRESH_CRON) {
      logEvent("CRON_KEY_UNKNOWN", { message: `CRON_KEY_UNKNOWN ${cron} has no task here; nothing ran` }, { level: "error" });
    }

    if (cron === BACKUP_CRON) {
      ctx.waitUntil(
        runTask(
          env,
          "backup",
          () => runBackup(env),
          (result): TaskResult => {
            if (!result.ran) {
              logEvent("BACKUP_CRON_SKIPPED", { message: `BACKUP_CRON_SKIPPED ${result.skipped}` }, { level: "error" });
              return { outcome: "skipped", reason: `skipped: ${result.skipped}` };
            }
            if (result.prune_refused !== null) {
              logEvent("BACKUP_CRON_REFUSED_PRUNE", { message: `BACKUP_CRON_REFUSED_PRUNE ${result.prune_refused}` }, { level: "error" });
              return { outcome: "refused", reason: `wrote ${result.json_keys.length} dump objects, and the prune refused: ${result.prune_refused}` };
            }
            return {
              outcome: "ok",
              reason: `wrote ${result.json_keys.length} dump objects (${result.documents} documents); pruned ${result.json_backups_pruned} dumps (${result.json_backups_locked} locked), ${result.versions_pruned} versions, ${result.audit_pruned} audit rows`,
            };
          },
          { tag: "BACKUP_CRON_THREW", rethrow: true }
        )
      );
      // Its own task, so a throw here cannot stop the backup (design-hybrid-search 3.4).
      ctx.waitUntil(
        runTask(
          env,
          "supersede",
          () => supersedePass(env),
          (report): TaskResult => {
            if (report.marked.length === 0) return null;
            const line = report.marked.map((m) => `${m.document} by ${m.by}`).join("; ");
            return { outcome: "ok", reason: `marked ${report.marked.length} superseded${report.more ? " (more next pass)" : ""}: ${line}` };
          },
          { tag: "SUPERSEDE_PASS_THREW", rethrow: true }
        )
      );
    }

    if (cron === TICK_CRON) {
      ctx.waitUntil(
        runTask(
          env,
          "tick",
          // The tick's signed-in crawl asks serve() for the Portal's pages in-process (src/signed-in-crawl.ts), past the
          // request log and the 404 count, so a crawl is never recorded as a visit.
          () => runTick(env, new Date(), (request) => serve(request, env, ctx)),
          (): TaskResult => ({ outcome: "ok", reason: "the tick's steps ran; each records its own run" }),
          { tag: "TICK_THREW", rethrow: true }
        )
      );
    }

    if (cron === SKILLS_REFRESH_CRON) {
      ctx.waitUntil(
        runTask(
          env,
          "skills-refresh",
          () => runSkillsRefresh(env, new Date()),
          (outcome): TaskResult => {
            if (!outcome.ran) {
              logEvent("SKILLS_REFRESH_SKIPPED", { message: `SKILLS_REFRESH_SKIPPED ${outcome.skipped}` });
              // Not its day of the week is not a run; switched off is a skip worth showing.
              return outcome.skipped?.startsWith(NOT_ITS_DAY) ? null : { outcome: "skipped", reason: `skipped: ${outcome.skipped ?? "no reason given"}` };
            }
            const line = `checked=${outcome.checked} changed=${outcome.changed.join(",") || "none"} posted=${outcome.posted.join(",") || "none"}`;
            logEvent("SKILLS_REFRESH", { message: `SKILLS_REFRESH ${line}` });
            for (const r of outcome.refused) logEvent("SKILLS_REFRESH_REFUSED", { message: `SKILLS_REFRESH_REFUSED ${r.slug}: ${r.reason}` }, { level: "error" });
            return outcome.refused.length > 0
              ? { outcome: "refused", reason: `${line}; refused ${outcome.refused.map((r) => `${r.slug}: ${r.reason}`).join("; ")}` }
              : { outcome: "ok", reason: line };
          },
          { tag: "SKILLS_REFRESH_THREW", rethrow: true }
        )
      );
    }
  },
} satisfies ExportedHandler<Env>;
