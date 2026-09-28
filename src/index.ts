import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp";
import { adminGrantEmail } from "./auth";
import { adminAgentForEmail } from "./agents";
import { runBackup } from "./backup";
import { defaultHandler } from "./routes";
import { mcpOriginProblem, withSecurityHeaders } from "./headers";
import type { Env, Props } from "./env";
import { buildServer } from "./server";
import { chicagoHour } from "./improve-schema";
import { openRuns, tickRuns } from "./improve-run";
import { runSkillsRefresh } from "./skills-refresh";

// Spelled once. wrangler.jsonc declares them; test/improve-cron.test.ts derives
// one list from the other and fails in both directions.
export const BACKUP_CRON = "0 9 * * *";
export const IMPROVE_OPEN_CRON = "0 8,9 * * *";
export const IMPROVE_TICK_CRON = "*/5 * * * *";
// Fires daily; readSchedule decides from KV whether today is the configured day, so
// the weekly schedule changes without a redeploy.
export const SKILLS_REFRESH_CRON = "30 9 * * *";

// 03:00 America/Chicago.
const IMPROVE_OPEN_HOUR_CT = 3;

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Checked on every request, not only at sign-in (src/auth.ts adminGrantEmail).
    const email = adminGrantEmail(env, (ctx as ExecutionContext & { props?: Props }).props);
    if (!email) {
      return new Response("forbidden: capsid is a single-user server and this grant does not belong to its administrator", {
        status: 403,
      });
    }
    // The admin agent holds every scope; the email Access verified is the audit actor.
    return createMcpHandler(buildServer(env, adminAgentForEmail(email)), { route: "/mcp" })(request, env, ctx);
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

const CANONICAL_MCP_URL = "https://capsid.dustin-edwards.workers.dev/mcp";

const provider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  resourceMetadata: { resource: CANONICAL_MCP_URL },
  // CIMD only (capsid/mcp-wrapper-standard.md, amendment 2026-09-27; design PR 4 of
  // capsid/research/design-capsid-access-login.md): a client's id is the URL of its
  // metadata document, and there is no registration endpoint. Clients registered by
  // DCR before PR 4 keep their KV records until the registration TTL they were given.
  // The provider advertises CIMD only while the global_fetch_strictly_public
  // compatibility flag is set (wrangler.jsonc.example).
  clientIdMetadataDocumentEnabled: true,
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/mcp") {
      const originProblem = mcpOriginProblem(request);
      if (originProblem) {
        return withSecurityHeaders(withCacheDefault(new Response(originProblem, { status: 403 }), pathname));
      }
    }
    const response = await provider.fetch(request, env, ctx);
    return withSecurityHeaders(withCacheDefault(response, pathname));
  },
  // Dispatch on controller.cron, not the clock: 09:00 UTC matches three of the
  // four expressions and Cloudflare delivers once per expression. Open cron is two
  // UTC hours because 03:00 America/Chicago is 08:00 or 09:00 depending on DST;
  // chicagoHour() picks the real 03:00. Each branch is its own try so a throwing
  // tick cannot stop the backup.
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const cron = controller.cron;

    if (cron === BACKUP_CRON) {
      ctx.waitUntil(
        runBackup(env)
          .then((result) => {
            if (result.ran && result.prune_refused !== null) {
              console.error(`BACKUP_CRON_REFUSED_PRUNE ${result.prune_refused}`);
            } else if (!result.ran) {
              console.error(`BACKUP_CRON_SKIPPED ${result.skipped}`);
            }
          })
          .catch((err) => {
            console.error(`BACKUP_CRON_THREW ${err instanceof Error ? `${err.message}
${err.stack}` : String(err)}`);
            throw err;
          })
      );
    }

    if (cron === IMPROVE_OPEN_CRON) {
      const now = new Date();
      const hour = chicagoHour(now);
      if (hour !== IMPROVE_OPEN_HOUR_CT) {
        console.log(`IMPROVE_OPEN_SKIPPED local hour is ${hour}, not ${IMPROVE_OPEN_HOUR_CT}`);
      } else {
        ctx.waitUntil(
          openRuns(env, now)
            .then((summary) => {
              console.log(
                `IMPROVE_OPENED mode=${summary.mode} ${summary.outcomes
                  .map((o) => `${o.namespace}:${o.opened ? "opened" : "skipped"}`)
                  .join(" ")}`
              );
            })
            .catch((err) => {
              console.error(`IMPROVE_OPEN_THREW ${err instanceof Error ? `${err.message}
${err.stack}` : String(err)}`);
              throw err;
            })
        );
      }
    }

    if (cron === IMPROVE_TICK_CRON) {
      ctx.waitUntil(
        tickRuns(env, new Date())
          .then((outcomes) => {
            for (const o of outcomes) {
              console.log(`IMPROVE_TICK ${o.runId} ${o.from} -> ${o.to}: ${o.note}`);
            }
          })
          .catch((err) => {
            console.error(`IMPROVE_TICK_THREW ${err instanceof Error ? `${err.message}
${err.stack}` : String(err)}`);
            throw err;
          })
      );
    }

    if (cron === SKILLS_REFRESH_CRON) {
      ctx.waitUntil(
        runSkillsRefresh(env, new Date())
          .then((outcome) => {
            if (!outcome.ran) {
              console.log(`SKILLS_REFRESH_SKIPPED ${outcome.skipped}`);
              return;
            }
            console.log(
              `SKILLS_REFRESH checked=${outcome.checked} changed=${outcome.changed.join(",") || "none"} posted=${outcome.posted.join(",") || "none"}`
            );
            for (const r of outcome.refused) console.error(`SKILLS_REFRESH_REFUSED ${r.slug}: ${r.reason}`);
          })
          .catch((err) => {
            console.error(`SKILLS_REFRESH_THREW ${err instanceof Error ? `${err.message}
${err.stack}` : String(err)}`);
            throw err;
          })
      );
    }
  },
} satisfies ExportedHandler<Env>;
