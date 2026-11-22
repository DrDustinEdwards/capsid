import { jsonResponse, textResponse } from "@dustinedwards/site-runtime/http";
import type { Env } from "./env";
import { cloudflareCredentials, type FetchLike } from "./ops-cloudflare";
import { readSiteRow } from "./ops-sites";
import type { PortalBuildLog, PortalWorkersBuilds, WorkersBuild } from "./ops-types/views";
import { behindGate } from "./portal-auth";
import { attempt, countedRead, none, noSite } from "./portal-site";
import { BUILDS_DEFAULT, BUILDS_MAX, buildLogs, listBuilds } from "./workers-builds";

// A site page's Deploys tab (src/portal-site.ts has the rest of the site page): its Workers
// Builds and one build's log, read live for one namespace.
//   GET /portal/api/workers-builds?namespace=&limit=   listBuilds
//   GET /portal/api/build-log?build=          buildLogs (capsid_admin_read_ops actions workers_builds and workers_build_logs)

export const PORTAL_WORKERS_BUILDS_PATH = "/portal/api/workers-builds";
export const PORTAL_BUILD_LOG_PATH = "/portal/api/build-log";

const BUILD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Workers Builds and one build's log.

/** The deploys tab's builds: the Worker its site row names, newest first. */
export async function readWorkersBuilds(
  env: Env,
  namespace: string,
  limit: number,
  fetchImpl: FetchLike = fetch,
  now: Date = new Date(),
): Promise<PortalWorkersBuilds> {
  const generated = now.toISOString();
  const row = await readSiteRow(env.DB, namespace);
  const script = row?.script ?? null;
  if (!row) return { generated, namespace, script, builds: noSite(namespace, "Workers Builds") };
  if (!script) {
    return {
      generated,
      namespace,
      script,
      builds: none(
        "no_site",
        row.platform === "vercel"
          ? `${namespace} runs on Vercel, so it has no Workers Builds.`
          : `${namespace}'s site row names no Worker script, so its Workers Builds cannot be found. Add the script in Settings.`,
      ),
    };
  }
  const creds = cloudflareCredentials(env);
  if (!creds.ok)
    return {
      generated,
      namespace,
      script,
      builds: none("not_configured", `Workers Builds cannot be read: ${creds.reason}.`),
    };
  const builds = await attempt<{ builds: WorkersBuild[] }>(async () => {
    const read = await listBuilds(env, { script, limit }, fetchImpl, false);
    if (read.builds.length === 0) {
      return none(
        "empty",
        `Cloudflare has no Workers Builds for ${script}: it deploys some other way (CI running wrangler deploy), or has not built yet.`,
      );
    }
    return { ok: true, data: { builds: read.builds } };
  });
  return { generated, namespace, script, builds };
}

/** One build's log, its last lines. */
export async function readBuildLog(
  env: Env,
  buildUuid: string,
  fetchImpl: FetchLike = fetch,
  now: Date = new Date(),
): Promise<PortalBuildLog> {
  const generated = now.toISOString();
  const creds = cloudflareCredentials(env);
  if (!creds.ok)
    return {
      generated,
      build_uuid: buildUuid,
      log: none("not_configured", `Workers Builds cannot be read: ${creds.reason}.`),
    };
  const log = await attempt<{
    lines: string[];
    line_count: number;
    truncated: boolean;
    note: string | null;
  }>(async () => {
    const read = await buildLogs(env, { build_uuid: buildUuid }, fetchImpl);
    if (read.line_count === 0) return none("empty", `The log of build ${buildUuid} has no lines.`);
    return {
      ok: true,
      data: {
        lines: read.lines,
        line_count: read.line_count,
        truncated: read.truncated,
        note: read.note ?? null,
      },
    };
  });
  return { generated, build_uuid: buildUuid, log };
}

/** GET /portal/api/workers-builds?namespace=&limit=. */
export function handlePortalWorkersBuilds(
  request: Request,
  env: Env,
  now: Date = new Date(),
): Promise<Response> {
  return countedRead(
    request,
    env,
    now,
    { name: "limit", max: BUILDS_MAX, fallback: BUILDS_DEFAULT },
    (ns, limit) => readWorkersBuilds(env, ns, limit, fetch, now),
  );
}

/** GET /portal/api/build-log?build=<uuid>. */
export const handlePortalBuildLog = behindGate(async (request, env, now) => {
  const build = new URL(request.url).searchParams.get("build") ?? "";
  if (!BUILD_UUID.test(build))
    return textResponse(
      "build must be a build's id (a lowercase UUID), from GET /portal/api/workers-builds.",
      400,
    );
  return jsonResponse(await readBuildLog(env, build, fetch, now));
});
