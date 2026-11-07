import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { adminAgentForEmail } from "../src/agents.ts";
import { PORTAL_CALLBACK_PATH, PORTAL_PATH, PORTAL_PREFIX } from "../src/portal-auth.ts";
import { OPS_FEED_PATH, OPS_REFRESH_PATH } from "../src/ops-feed.ts";
import {
  PORTAL_ACTIVITY_PATH,
  PORTAL_API_PREFIX,
  PORTAL_NAMESPACES_PATH,
  PORTAL_PERFORM_PATH,
  PORTAL_PREVIEW_PATH,
  PORTAL_SIGN_OUT_PATH,
} from "../src/portal-actions.ts";
import { PORTAL_CLAIMS_PATH } from "../src/portal-claims.ts";
import { PORTAL_STALE_PATH } from "../src/portal-stale.ts";
import { PORTAL_DIGEST_PATH, PORTAL_PLAN_PATH } from "../src/portal-overnight.ts";
import { PORTAL_MERGE_UNITS_PATH } from "../src/portal-merge-units.ts";
import {
  PORTAL_BUILD_LOG_PATH,
  PORTAL_SITE_SEARCH_PATH,
  PORTAL_SITE_TRAFFIC_PATH,
  PORTAL_WORKERS_BUILDS_PATH,
} from "../src/portal-site.ts";
import { PORTAL_MAINTENANCE_PATH } from "../src/portal-maintenance.ts";
import { PORTAL_CONVERGENCE_PATH } from "../src/portal-convergence.ts";
import { PORTAL_BACKUPS_PATH } from "../src/portal-backups.ts";
import {
  PORTAL_COMPLETENESS_PATH,
  PORTAL_NOT_FOUND_PATH,
  PORTAL_PACKAGE_HISTORY_PATH,
  PORTAL_RESOURCES_PATH,
  PORTAL_SHARED_CODE_PATH,
} from "../src/portal-packages.ts";
import { PORTAL_PUSH_PATH } from "../src/push.ts";
import { PORTAL_LIBRARY_PATH } from "../src/portal-library.ts";
import { PORTAL_TRENDS_PATH } from "../src/portal-trends.ts";
import { REPORT_PATH } from "../src/security-headers.ts";
import { VERIFY_LIVE_CLIENT_PATH } from "../src/oauth-client-docs.ts";
import { BACKUP_CREDENTIAL_PATH } from "../src/signed-requests.ts";
import { OFFACCOUNT_REPORT_PATH } from "../src/offaccount.ts";
import {
  BENCH_DRAW_PATH,
  BENCH_REPRO_PATH,
  BENCH_SCORE_PATH,
  BENCH_START_PATH,
  BENCH_TASKS_PATH,
} from "../src/bench.ts";
import { SHADOW_JOB_PATH, SHADOW_RESULT_PATH } from "../src/shadow.ts";
import { REVIEW_RUN_PATH } from "../src/review.ts";
import {
  PUBLIC_CODE_PATH,
  PUBLIC_MODEL_PATH,
  PUBLIC_STATS_PATH,
  PUBLIC_VERSIONS_PATH,
} from "../src/public-data.ts";
import { SIGNED_IN_REPORT_PATH } from "../src/signed-in-crawl.ts";
import { ROUTE_GRANTS, UNGATED_ROUTES, requiredForAction } from "../src/scope.ts";
import { fakeEnv, fakeKv } from "./fakes.ts";
import { buildAdminServer, buildServer } from "../src/server.ts";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

// Every route goes through the one enforcement point, or says why it does not. A
// route that checks only the write grant lets a driver minted for one namespace act
// across every namespace.
//
// The routes themselves are driven through the whole Worker in
// test-integration/route-gates.test.ts. node --test cannot load src/routes.ts, so
// what stays here is the one direction no request can show: every path defaultHandler
// dispatches on is in one of the two tables.

const ROUTES = readFileSync(join(import.meta.dirname, "..", "src", "routes.ts"), "utf8");

// every route

const PATH_CONSTANTS: Record<string, string> = {
  REPORT_PATH,
  VERIFY_LIVE_CLIENT_PATH,
  BACKUP_CREDENTIAL_PATH,
  OFFACCOUNT_REPORT_PATH,
  BENCH_TASKS_PATH,
  BENCH_DRAW_PATH,
  BENCH_START_PATH,
  BENCH_REPRO_PATH,
  BENCH_SCORE_PATH,
  SHADOW_JOB_PATH,
  SHADOW_RESULT_PATH,
  REVIEW_RUN_PATH,
  PORTAL_CALLBACK_PATH,
  OPS_FEED_PATH,
  OPS_REFRESH_PATH,
  PORTAL_PREVIEW_PATH,
  PORTAL_PERFORM_PATH,
  PORTAL_NAMESPACES_PATH,
  PORTAL_ACTIVITY_PATH,
  PORTAL_CLAIMS_PATH,
  PORTAL_STALE_PATH,
  PORTAL_PLAN_PATH,
  PORTAL_MERGE_UNITS_PATH,
  PORTAL_SITE_SEARCH_PATH,
  PORTAL_SITE_TRAFFIC_PATH,
  PORTAL_WORKERS_BUILDS_PATH,
  PORTAL_BUILD_LOG_PATH,
  PORTAL_DIGEST_PATH,
  PORTAL_MAINTENANCE_PATH,
  PORTAL_CONVERGENCE_PATH,
  PORTAL_BACKUPS_PATH,
  PORTAL_PACKAGE_HISTORY_PATH,
  PORTAL_SHARED_CODE_PATH,
  PORTAL_NOT_FOUND_PATH,
  PORTAL_RESOURCES_PATH,
  PORTAL_COMPLETENESS_PATH,
  PORTAL_LIBRARY_PATH,
  PORTAL_TRENDS_PATH,
  PORTAL_PUSH_PATH,
  PORTAL_SIGN_OUT_PATH,
  PORTAL_API_PREFIX,
  PORTAL_PATH,
  PORTAL_PREFIX,
  PUBLIC_MODEL_PATH,
  PUBLIC_STATS_PATH,
  SIGNED_IN_REPORT_PATH,
  PUBLIC_CODE_PATH,
  PUBLIC_VERSIONS_PATH,
};

// One entry per dispatch in defaultHandler (the formatter may wrap the return onto the next line): the path it
// matches and the handler it calls.
function dispatches(): { path: string; handler: string }[] {
  const body = ROUTES.slice(ROUTES.indexOf("export const defaultHandler"));
  assert.ok(body.length > 0, "defaultHandler not found in src/routes.ts");
  const found: { path: string; handler: string }[] = [];
  const line = /url\.pathname === ("[^"]+"|[A-Z_]+)[^\n]*?(?:\n\s*)?\breturn (\w+)\(/g;
  const resolve = (raw: string): string => {
    if (raw.startsWith('"')) return raw.slice(1, -1);
    assert.ok(
      Object.hasOwn(PATH_CONSTANTS, raw),
      `defaultHandler matches on ${raw}, which this test cannot resolve. Import it into PATH_CONSTANTS.`,
    );
    return PATH_CONSTANTS[raw];
  };
  for (const m of body.matchAll(line)) found.push({ path: resolve(m[1]), handler: m[2] });
  // A prefix match covers every path under it, so it is a route of its own, named in
  // the tables as the prefix with a trailing `*` ("/portal/*").
  const prefix = /url\.pathname\.startsWith\(("[^"]+"|[A-Z_]+)\)[^\n]*?(?:\n\s*)?\breturn (\w+)\(/g;
  for (const m of body.matchAll(prefix)) found.push({ path: `${resolve(m[1])}*`, handler: m[2] });
  // A match written any other way (startsWith, a regex, a switch) would be missed by
  // the pattern above, so every mention of the pathname must be one the pattern read.
  const mentions = body.match(/pathname/g)?.length ?? 0;
  assert.equal(
    mentions,
    found.length,
    `defaultHandler reads url.pathname ${mentions} times and this test parsed ${found.length} dispatch lines`,
  );
  return found;
}

// scanner-rule: one enforcement point invariant, every route is a decision. Derived over every dispatch line in src/routes.ts
test("every route in defaultHandler is either gated through checkScope or listed as ungated with a reason", () => {
  const routes = dispatches();
  const paths = new Set(routes.map((r) => r.path));
  assert.ok(
    paths.size > 0,
    "parsed no dispatch lines out of defaultHandler, so this guard is vacuous",
  );

  for (const path of paths) {
    const gated = Object.hasOwn(ROUTE_GRANTS, path);
    const ungated = Object.hasOwn(UNGATED_ROUTES, path);
    assert.ok(
      gated || ungated,
      `route ${path} is in neither ROUTE_GRANTS nor UNGATED_ROUTES in src/scope.ts. Decide which.`,
    );
    assert.ok(!(gated && ungated), `route ${path} is in both ROUTE_GRANTS and UNGATED_ROUTES`);
    if (ungated)
      assert.ok(
        UNGATED_ROUTES[path].trim().length > 20,
        `route ${path} is listed as ungated with no real reason`,
      );
  }
  // The other direction, that no table entry is stale, is driven through the Worker in
  // test-integration/route-gates.test.ts.
});

// the table is the whole statement

async function servedActions(build: typeof buildServer, name: string): Promise<string[]> {
  const server = build(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgentForEmail("admin@example.com"));
  const client = new Client({ name: "route-gates", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  const served = tools.find((tool) => tool.name === name)?.inputSchema.properties?.action as
    | { enum?: string[] }
    | undefined;
  return served?.enum ?? [];
}

test("capsid_read_status serves status and the versions model, as reads, and the admin's switches are admin", async () => {
  // The actions come from the schemas the servers serve, so an action added to either
  // tool without a decision here fails.
  const driver = await servedActions(buildServer, "capsid_read_status");
  assert.deepEqual(
    driver,
    ["status", "versions"],
    "capsid_read_status's action list changed; decide its requirement here and in TOOL_ACTION_GRANTS",
  );
  assert.equal(requiredForAction("capsid_read_status", "status"), "read");
  // The versions model is the public document (/public/versions/v1.json), so a read.
  assert.equal(requiredForAction("capsid_read_status", "versions"), "read");

  const admin = await servedActions(buildAdminServer, "capsid_admin_manage_switches");
  // The overnight run's switch (src/overnight.ts) and the queue's circuit breaker
  // (src/job-breaker.ts) are among them.
  assert.deepEqual(
    [...admin].sort(),
    ["breaker_reset", "overnight", "sign_policy"],
    "capsid_admin_manage_switches's action list changed",
  );
  for (const action of admin)
    assert.equal(
      requiredForAction("capsid_admin_manage_switches", action),
      "admin",
      `capsid_admin_manage_switches.${action}`,
    );
  for (const action of admin) assert.ok(!driver.includes(action), `${action} is served to drivers`);
});
