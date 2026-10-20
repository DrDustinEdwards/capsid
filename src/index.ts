import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { adminGrantEmail } from "./auth";
import { adminAgentForEmail } from "./agents";
import { readLastStepUp } from "./scope";
import { adminWriteObserver, recordAdminInitialize } from "./admin-client-audit";
import { runBackup } from "./backup";
import { supersedePass } from "./supersede";
import { defaultHandler } from "./routes";
import { mcpOriginProblem, withSecurityHeaders } from "./security-headers";
import type { Env, Props } from "./env";
import { buildAdminServer, buildServer } from "./server";
import { ADMIN_MCP_ROUTE, serveMcp } from "./mcp-handler";
import { gateRegistration, REGISTER_PATH } from "./dcr";
import { runTick } from "./tick";
import { NOT_ITS_DAY, runSkillsRefresh } from "./skills-refresh";
import { runTask, type TaskResult } from "./task-runs";
import { portalHostRequest } from "./portal-host";
import { hostRefusal, LEGACY_HOST, LEGACY_MCP_URL, MCP_URL } from "./mcp-host";
import { logEvent } from "./log";

// Spelled once. wrangler.jsonc declares them; test/crons.test.ts derives one list
// from the other and fails in both directions.
export const BACKUP_CRON = "0 9 * * *";
export const TICK_CRON = "*/5 * * * *";
// Fires daily; readSchedule decides from KV whether today is the configured day, so
// the weekly schedule changes without a redeploy.
export const SKILLS_REFRESH_CRON = "30 9 * * *";

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Checked on every request, not only at sign-in (src/auth.ts adminGrantEmail).
    const email = await adminGrantEmail(env, (ctx as ExecutionContext & { props?: Props }).props);
    if (!email) {
      return new Response("forbidden: this grant does not belong to an administrator of capsid", {
        status: 403,
      });
    }
    // The admin agent holds every scope; the email Access verified is the audit actor.
    const props = (ctx as ExecutionContext & { props?: Props }).props;
    const signedInAt = typeof props?.signed_in_at === "number" ? props.signed_in_at : null;
    const admin = adminAgentForEmail(email, signedInAt);
    // Only Capsid Admin serves step-up actions, so only its route reads the clock. A KV
    // failure leaves it undefined, which falls back to the sign-in time alone (src/scope.ts STEP_UP).
    const adminRoute = new URL(request.url).pathname === ADMIN_MCP_ROUTE;
    if (adminRoute && signedInAt !== null) admin.lastStepUpAt = await readLastStepUp(env.APP_KV, admin.actor, signedInAt);
    // Observation only, for 30 days (src/admin-client-audit.ts): which client the admin
    // acts through. It never refuses on what the client says.
    await recordAdminInitialize(env.DB, admin.actor, request);
    const observe = adminWriteObserver(env.DB, admin.actor, request.headers.get("User-Agent"));
    // Capsid Admin on its own route (capsid/rulings/mcp-2026-10-10.md, amendment answer
    // 2): the eight administrator tools, never on /mcp. Only the administrator's grant
    // reaches this handler at all, and the step-up in src/scope.ts guards its risky actions.
    if (adminRoute) {
      return serveMcp(request, env, ctx, ADMIN_MCP_ROUTE, () => buildAdminServer(env, admin, "", observe));
    }
    return serveMcp(request, env, ctx, "/mcp", () => buildServer(env, admin, "", observe));
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
// The step that turns workers.dev off removes legacyProvider.
function oauthProvider(resource: string, registration: boolean) {
  return new OAuthProvider({
    apiRoute: "/mcp",
    apiHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    resourceMetadata: { resource },
    // CIMD first (capsid/mcp-wrapper-standard.md, amendment 2026-09-27): a client's id is
    // the URL of its metadata document. The provider advertises CIMD only while the
    // global_fetch_strictly_public compatibility flag is set (wrangler.jsonc.example).
    clientIdMetadataDocumentEnabled: true,
    // Tightened DCR for Grok and Gemini (capsid/rulings/mcp-2026-10-10.md, rule 13), on
    // the MCP host only: src/dcr.ts judges every registration before the provider
    // sees it. The old address keeps none; it is going.
    ...(registration ? { clientRegistrationEndpoint: REGISTER_PATH } : {}),
  });
}

const provider = oauthProvider(MCP_URL, true);
const legacyProvider = oauthProvider(LEGACY_MCP_URL, false);

export default {
  async fetch(original: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // portal.dustinedwards.info serves the Portal and nothing else (src/portal-host.ts):
    // /x there is /portal/x here, and an old /portal address redirects to the root. It
    // runs FIRST, before the OAuth provider, because the provider answers its own routes
    // (/mcp, /token, /authorize, /register, its metadata) without reaching the routes
    // handler. Behind the provider, /mcp on the Portal host was the MCP endpoint, and
    // live gate 7 rolled #218's deploy back (run 36863432268).
    const host = portalHostRequest(original);
    if ("redirect" in host) return withSecurityHeaders(host.redirect);
    const request = host.request;
    // The MCP host serves the machine surface only, and the old address's /portal is
    // retired (src/mcp-host.ts). Also before the provider, for the same reason.
    const refused = hostRefusal(request);
    if (refused) return withSecurityHeaders(withCacheDefault(refused, new URL(request.url).pathname));
    const pathname = new URL(request.url).pathname;
    if (pathname === "/mcp" || pathname === ADMIN_MCP_ROUTE) {
      const originProblem = mcpOriginProblem(request);
      if (originProblem) {
        return withSecurityHeaders(withCacheDefault(new Response(originProblem, { status: 403 }), pathname));
      }
    }
    const legacy = new URL(request.url).hostname === LEGACY_HOST;
    let forwarded = request;
    if (!legacy && pathname === REGISTER_PATH && request.method === "POST") {
      const gate = await gateRegistration(request, env, new Date());
      if ("refuse" in gate) return withSecurityHeaders(withCacheDefault(gate.refuse, pathname));
      forwarded = gate.forward;
    }
    const response = await (legacy ? legacyProvider : provider).fetch(forwarded, env, ctx);
    return withSecurityHeaders(withCacheDefault(response, pathname));
  },
  // Dispatch on controller.cron, not the clock: 09:00 UTC matches all three
  // expressions and Cloudflare delivers once per expression. Each branch is its own
  // task so a throwing tick cannot stop the backup. runTask (src/task-runs.ts) records every run in the
  // run ledger, logs a throw with the tag named here, and rethrows it so the
  // invocation shows as failed.
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const cron = controller.cron;

    if (cron === BACKUP_CRON) {
      ctx.waitUntil(
        runTask(
          env,
          "backup",
          () => runBackup(env),
          (result): TaskResult => {
            if (!result.ran) {
              logEvent("error", "BACKUP_CRON_SKIPPED", { message: `BACKUP_CRON_SKIPPED ${result.skipped}` });
              return { outcome: "skipped", reason: `skipped: ${result.skipped}` };
            }
            if (result.prune_refused !== null) {
              logEvent("error", "BACKUP_CRON_REFUSED_PRUNE", { message: `BACKUP_CRON_REFUSED_PRUNE ${result.prune_refused}` });
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
          () => runTick(env, new Date()),
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
              logEvent("log", "SKILLS_REFRESH_SKIPPED", { message: `SKILLS_REFRESH_SKIPPED ${outcome.skipped}` });
              // Not its day of the week is not a run; switched off is a skip worth showing.
              return outcome.skipped?.startsWith(NOT_ITS_DAY) ? null : { outcome: "skipped", reason: `skipped: ${outcome.skipped ?? "no reason given"}` };
            }
            const line = `checked=${outcome.checked} changed=${outcome.changed.join(",") || "none"} posted=${outcome.posted.join(",") || "none"}`;
            logEvent("log", "SKILLS_REFRESH", { message: `SKILLS_REFRESH ${line}` });
            for (const r of outcome.refused) logEvent("error", "SKILLS_REFRESH_REFUSED", { message: `SKILLS_REFRESH_REFUSED ${r.slug}: ${r.reason}` });
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
