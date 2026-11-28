import { behindGate } from "./portal-auth";
import { readSharedCode } from "./shared-code-read";
import { readCompleteness } from "./completeness";
import { readResources } from "./system-facts-store";
import { jsonResponse } from "@dustinedwards/site-runtime/http";
import { notFoundReport } from "@dustinedwards/site-runtime/not-found";
import type { PortalNotFound } from "./ops-types/sites";

import { errorMessage } from "@dustinedwards/site-runtime/log";

// The Sites view's 404 panel: GET /portal/api/not-found. Capsid's own counts,
// page_404_daily, read with site-runtime's notFoundReport; each other site keeps its table in
// its own D1, which Capsid does not read. Gated like the reads above; it reads D1 only.
export const PORTAL_NOT_FOUND_PATH = "/portal/api/not-found";
const NOT_FOUND_DAYS = 30;

export const handlePortalNotFound = behindGate(async (_request, env, now) => {
  let body: PortalNotFound;
  try {
    const all = await notFoundReport(env.DB, {
      days: NOT_FOUND_DAYS,
      limit: 500,
      includeProbes: true,
      now,
    });
    const pages = all
      .filter((e) => e.kind === "page")
      .slice(0, 50)
      .map(({ path, hits, referrers }) => ({ path, hits, referrers }));
    body = {
      days: NOT_FOUND_DAYS,
      generated: now.toISOString(),
      pages,
      probes: all.filter((e) => e.kind === "probe").reduce((n, e) => n + e.hits, 0),
      error: null,
    };
  } catch (err) {
    body = {
      days: NOT_FOUND_DAYS,
      generated: now.toISOString(),
      pages: null,
      probes: null,
      error: errorMessage(err).slice(0, 200),
    };
  }
  return jsonResponse(body);
});

// The Shared code view's read: GET /portal/api/shared-code (src/shared-code.ts). It
// answers to portalGate and nothing else, writes only its own hour-long cache, and reads GitHub only for the configured packages and the configured sites' repos.
export const PORTAL_SHARED_CODE_PATH = "/portal/api/shared-code";

export const handlePortalSharedCode = behindGate(async (_request, env, now) => {
  const body = await readSharedCode(env, now);
  return jsonResponse(body);
});

// The Completeness view's read: GET /portal/api/completeness (src/completeness.ts). devkit's
// daily scoreboard, read through the GitHub App from devkit's scoreboard branch. Gated and
// cached like the Shared code view above; it reads that one file and nothing else.
export const PORTAL_COMPLETENESS_PATH = "/portal/api/completeness";

export const handlePortalCompleteness = behindGate(async (_request, env, now) => {
  const body = await readCompleteness(env, now);
  return jsonResponse(body);
});

// The Workers tab's read: GET /portal/api/resources, the secrets and data model the nightly
// build stored (src/system-resources.ts). Private, so gated by portalGate like the views
// above; it reads one KV value and never calls Cloudflare.
export const PORTAL_RESOURCES_PATH = "/portal/api/resources";

export const handlePortalResources = behindGate(async (_request, env) => {
  const body = (await readResources(env)) ?? {
    version: 1,
    read_at: null,
    workers: [],
    databases: [],
    kv_namespaces: [],
    buckets: [],
    problems: ["The nightly build has not read Cloudflare yet."],
  };
  return jsonResponse(body);
});
