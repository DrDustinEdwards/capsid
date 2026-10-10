import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sha256Hex } from "../src/auth.ts";
import { defaultScopes, serializeScopes } from "../src/agents-schema.ts";
import { adminAgentForEmail, resolveAgent } from "../src/agents.ts";
import { PORTAL_CALLBACK_PATH, PORTAL_PATH, PORTAL_PREFIX } from "../src/portal-auth.ts";
import { OPS_FEED_PATH, OPS_REFRESH_PATH } from "../src/ops-feed.ts";
import { OPS_HOOKS_PATH } from "../src/ops-hooks.ts";
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
import { PORTAL_MAINTENANCE_PATH } from "../src/portal-maintenance.ts";
import { PORTAL_CONVERGENCE_PATH } from "../src/portal-convergence.ts";
import { PORTAL_PACKAGE_HISTORY_PATH } from "../src/portal-packages.ts";
import { REPORT_PATH } from "../src/headers.ts";
import { RUNNER_KEY_PATH } from "../src/runner-key.ts";
import { OTLP_LOGS_PATH, OTLP_METRICS_PATH } from "../src/ops-otlp.ts";
import { BACKUP_CREDENTIAL_PATH, CREDENTIAL_PATH, SCORE_PATH } from "../src/improve-scorer.ts";
import {
  ROUTE_GRANTS,
  UNGATED_ROUTES,
  requiredForAction,
  routeRefusal,
} from "../src/scope.ts";
import { fakeD1, fakeEnv, fakeKv } from "./fakes.ts";
import { buildServer } from "../src/server.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Every route goes through the one enforcement point, or says why it does not. A
// route that checks only the write grant lets a driver minted for one namespace act
// across every namespace (for /ops/backup, a full backup and its prune).
//
// The routes themselves are driven through the whole Worker in
// test-integration/route-gates.test.ts. node --test cannot load src/routes.ts, so
// what stays here is routeRefusal over callers resolved for real, and the one
// direction no request can show: every path defaultHandler dispatches on is in one of
// the two tables.

const DRIVER_KEY = "capsid_agent_" + "d".repeat(64);
const LEGACY_WRITE_KEY = "legacy-write-key";
const LEGACY_READ_KEY = "legacy-read-key";
const ROUTES = readFileSync(join(import.meta.dirname, "..", "src", "routes.ts"), "utf8");

async function resolveWith(bearer: string) {
  const scopes = defaultScopes(["capsid"]);
  scopes.grants = ["read", "write"];
  const d1 = fakeD1({
    agents: [
      {
        id: "agent_driver000001",
        name: "capsid-driver",
        kind: "driver",
        key_hash: await sha256Hex(DRIVER_KEY),
        scopes: serializeScopes(scopes),
        created_by: "github:dustin",
        created_at: "2026-09-11 00:00:00",
        revoked_at: null,
        last_seen: null,
      },
    ],
  });
  const hashes = `${await sha256Hex(LEGACY_WRITE_KEY)},ro:${await sha256Hex(LEGACY_READ_KEY)}`;
  const env = fakeEnv({ DB: d1.db, OPERATOR_KEY_HASH: hashes });
  const req = new Request("https://capsid.example/ops/backup", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}` },
  });
  const resolved = await resolveAgent(req, env);
  assert.ok(resolved, "the key did not resolve, so this test would prove nothing about the gate");
  return resolved.agent;
}

// /ops/backup

test("/ops/backup admits the legacy write-grant operator key, which is the admin", async () => {
  const agent = await resolveWith(LEGACY_WRITE_KEY);
  assert.equal(agent.admin, true, "the legacy write key stopped resolving to the admin, so docs/backups.md is wrong");
  assert.equal(routeRefusal("/ops/backup", agent), null);
});

test("/ops/backup refuses the legacy read-only operator key", async () => {
  const agent = await resolveWith(LEGACY_READ_KEY);
  assert.ok(routeRefusal("/ops/backup", agent));
});

test("/ops/backup admits the OAuth admin", () => {
  assert.equal(routeRefusal("/ops/backup", adminAgentForEmail("admin@example.com")), null);
});

test("a path in neither table is refused to everyone but the admin", async () => {
  // routeRefusal fails closed: a route wired to it before its table entry exists is
  // admin only, never open.
  assert.ok(routeRefusal("/ops/not-a-route", await resolveWith(DRIVER_KEY)));
  assert.equal(routeRefusal("/ops/not-a-route", adminAgentForEmail("admin@example.com")), null);
});

// every route

const PATH_CONSTANTS: Record<string, string> = {
  REPORT_PATH,
  SCORE_PATH,
  CREDENTIAL_PATH,
  BACKUP_CREDENTIAL_PATH,
  PORTAL_CALLBACK_PATH,
  RUNNER_KEY_PATH,
  OTLP_METRICS_PATH,
  OTLP_LOGS_PATH,
  OPS_FEED_PATH,
  OPS_REFRESH_PATH,
  OPS_HOOKS_PATH,
  PORTAL_PREVIEW_PATH,
  PORTAL_PERFORM_PATH,
  PORTAL_NAMESPACES_PATH,
  PORTAL_ACTIVITY_PATH,
  PORTAL_CLAIMS_PATH,
  PORTAL_STALE_PATH,
  PORTAL_MAINTENANCE_PATH,
  PORTAL_CONVERGENCE_PATH,
  PORTAL_PACKAGE_HISTORY_PATH,
  PORTAL_SIGN_OUT_PATH,
  PORTAL_API_PREFIX,
  PORTAL_PATH,
  PORTAL_PREFIX,
};

// One entry per dispatch line in defaultHandler: the path it matches and the
// handler it calls.
function dispatches(): { path: string; handler: string }[] {
  const body = ROUTES.slice(ROUTES.indexOf("export const defaultHandler"));
  assert.ok(body.length > 0, "defaultHandler not found in src/routes.ts");
  const found: { path: string; handler: string }[] = [];
  const line = /url\.pathname === ("[^"]+"|[A-Z_]+)[^\n]*?\breturn (\w+)\(/g;
  const resolve = (raw: string): string => {
    if (raw.startsWith('"')) return raw.slice(1, -1);
    assert.ok(Object.hasOwn(PATH_CONSTANTS, raw), `defaultHandler matches on ${raw}, which this test cannot resolve. Import it into PATH_CONSTANTS.`);
    return PATH_CONSTANTS[raw];
  };
  for (const m of body.matchAll(line)) found.push({ path: resolve(m[1]), handler: m[2] });
  // A prefix match covers every path under it, so it is a route of its own, named in
  // the tables as the prefix with a trailing `*` ("/portal/*").
  const prefix = /url\.pathname\.startsWith\(("[^"]+"|[A-Z_]+)\)[^\n]*?\breturn (\w+)\(/g;
  for (const m of body.matchAll(prefix)) found.push({ path: `${resolve(m[1])}*`, handler: m[2] });
  // A match written any other way (startsWith, a regex, a switch) would be missed by
  // the pattern above, so every mention of the pathname must be one the pattern read.
  const mentions = body.match(/pathname/g)?.length ?? 0;
  assert.equal(mentions, found.length, `defaultHandler reads url.pathname ${mentions} times and this test parsed ${found.length} dispatch lines`);
  return found;
}

// scanner-rule: CLAUDE.md, one enforcement point rule, every route is a decision. Derived over every dispatch line in src/routes.ts
test("every route in defaultHandler is either gated through checkScope or listed as ungated with a reason", () => {
  const routes = dispatches();
  const paths = new Set(routes.map((r) => r.path));
  assert.ok(paths.size > 0, "parsed no dispatch lines out of defaultHandler, so this guard is vacuous");

  for (const path of paths) {
    const gated = Object.hasOwn(ROUTE_GRANTS, path);
    const ungated = Object.hasOwn(UNGATED_ROUTES, path);
    assert.ok(gated || ungated, `route ${path} is in neither ROUTE_GRANTS nor UNGATED_ROUTES in src/scope.ts. Decide which.`);
    assert.ok(!(gated && ungated), `route ${path} is in both ROUTE_GRANTS and UNGATED_ROUTES`);
    if (ungated) assert.ok(UNGATED_ROUTES[path].trim().length > 20, `route ${path} is listed as ungated with no real reason`);
  }
  // The other direction, that no table entry is stale, is driven through the Worker in
  // test-integration/route-gates.test.ts.
});

// the table is the whole statement

test("improve_run: run and claim are a driver's work and every other action is admin", async () => {
  // The actions come from the schema the server serves, so an action added to the tool
  // without a decision here fails.
  const server = buildServer(fakeEnv({ APP_KV: fakeKv({}).kv }), adminAgentForEmail("admin@example.com"));
  const client = new Client({ name: "route-gates", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  const served = tools.find((tool) => tool.name === "improve_run")?.inputSchema.properties?.action as { enum?: string[] } | undefined;
  const actions = served?.enum ?? [];
  assert.equal(actions.length, 13, "improve_run's action list changed");
  const expected: Record<string, string> = {
    run: "write",
    claim: "write",
    mode: "admin",
    pause: "admin",
    unpause: "admin",
    budget: "admin",
    mint_operator_key: "admin",
    sign_policy: "admin",
    register_skill: "admin",
    skill_transitions: "admin",
    seat_start: "admin",
    // The overnight run's switch, with the subscription decision recorded (src/overnight.ts).
    overnight: "admin",
    // The queue's circuit breaker is closed only by the seat or Dustin (src/job-breaker.ts).
    breaker_reset: "admin",
  };
  for (const action of actions) {
    assert.ok(Object.hasOwn(expected, action), `improve_run gained action '${action}'; decide its requirement here and in TOOL_ACTION_GRANTS`);
    assert.equal(requiredForAction("improve_run", action), expected[action], `improve_run.${action}`);
  }
  // An omitted action is a run.
  assert.equal(requiredForAction("improve_run", undefined), "write");
});
