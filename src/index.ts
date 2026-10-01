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
import { NOT_ITS_DAY, runSkillsRefresh } from "./skills-refresh";
import { runTask, type TaskResult } from "./task-runs";

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
  // chicagoHour() picks the real 03:00. Each branch is its own task so a throwing
  // tick cannot stop the backup. runTask (src/task-runs.ts) records every run in the
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
              console.error(`BACKUP_CRON_SKIPPED ${result.skipped}`);
              return { outcome: "skipped", reason: `skipped: ${result.skipped}` };
            }
            if (result.prune_refused !== null) {
              console.error(`BACKUP_CRON_REFUSED_PRUNE ${result.prune_refused}`);
              return { outcome: "refused", reason: `wrote ${result.json_keys.length} dump objects, and the prune refused: ${result.prune_refused}` };
            }
            return {
              outcome: "ok",
              reason: `wrote ${result.json_keys.length} dump objects (${result.documents} documents); pruned ${result.json_backups_pruned} dumps, ${result.versions_pruned} versions, ${result.audit_pruned} audit rows`,
            };
          },
          { tag: "BACKUP_CRON_THREW", rethrow: true }
        )
      );
    }

    if (cron === IMPROVE_OPEN_CRON) {
      const now = new Date();
      const hour = chicagoHour(now);
      if (hour !== IMPROVE_OPEN_HOUR_CT) {
        // The other of the two UTC hours: not a run, so not recorded.
        console.log(`IMPROVE_OPEN_SKIPPED local hour is ${hour}, not ${IMPROVE_OPEN_HOUR_CT}`);
      } else {
        ctx.waitUntil(
          runTask(
            env,
            "improve-open",
            () => openRuns(env, now),
            (summary): TaskResult => {
              const line = `mode=${summary.mode} ${summary.outcomes.map((o) => `${o.namespace}:${o.opened ? "opened" : "skipped"}`).join(" ")}`;
              console.log(`IMPROVE_OPENED ${line}`);
              return { outcome: "ok", reason: line };
            },
            { tag: "IMPROVE_OPEN_THREW", rethrow: true }
          )
        );
      }
    }

    if (cron === IMPROVE_TICK_CRON) {
      ctx.waitUntil(
        runTask(
          env,
          "tick",
          () => tickRuns(env, new Date()),
          (outcomes): TaskResult => {
            for (const o of outcomes) {
              console.log(`IMPROVE_TICK ${o.runId} ${o.from} -> ${o.to}: ${o.note}`);
            }
            const moved = outcomes.filter((o) => o.from !== o.to).length;
            return { outcome: "ok", reason: outcomes.length === 0 ? "no improve run to advance" : `${outcomes.length} improve run(s) looked at, ${moved} moved` };
          },
          { tag: "IMPROVE_TICK_THREW", rethrow: true }
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
              console.log(`SKILLS_REFRESH_SKIPPED ${outcome.skipped}`);
              // Not its day of the week is not a run; switched off is a skip worth showing.
              return outcome.skipped?.startsWith(NOT_ITS_DAY) ? null : { outcome: "skipped", reason: `skipped: ${outcome.skipped ?? "no reason given"}` };
            }
            const line = `checked=${outcome.checked} changed=${outcome.changed.join(",") || "none"} posted=${outcome.posted.join(",") || "none"}`;
            console.log(`SKILLS_REFRESH ${line}`);
            for (const r of outcome.refused) console.error(`SKILLS_REFRESH_REFUSED ${r.slug}: ${r.reason}`);
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
