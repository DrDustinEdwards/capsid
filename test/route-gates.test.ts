import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sha256Hex } from "../src/auth.ts";
import { defaultScopes, serializeScopes } from "../src/agents-schema.ts";
import { adminAgent, resolveAgent } from "../src/agents.ts";
import { CONSOLE_CALLBACK_PATH, CONSOLE_JSON_PATH, CONSOLE_PATH } from "../src/console.ts";
import { REPORT_PATH } from "../src/headers.ts";
import { BACKUP_CREDENTIAL_PATH, CREDENTIAL_PATH, SCORE_PATH } from "../src/improve-scorer.ts";
import {
  ADMIN_REASON,
  ROUTE_GRANTS,
  TOOL_ACTION_GRANTS,
  TOOL_GRANTS,
  UNGATED_ROUTES,
  requiredForAction,
  routeRefusal,
} from "../src/scope.ts";
import { fakeD1, fakeEnv } from "./fakes.ts";

// EVERY ROUTE GOES THROUGH THE ONE ENFORCEMENT POINT, OR SAYS WHY IT DOES NOT.
//
// Two audits on 2026-09-16 found /ops/backup outside it. handleBackup checked only
// that the caller held the write grant and never called checkScope, so a driver
// minted for one namespace could run a full backup, and the prune that follows it,
// across every namespace in the store. CLAUDE.md rule 6 says there is one
// enforcement point; this route was not in it.
//
// WHY THE ROUTE IS NOT DRIVEN: src/routes.ts imports the Agents SDK, which needs
// `cloudflare:workers`, and node --test cannot load that scheme. Nothing in this suite
// has ever driven defaultHandler for that reason (test/csp-rate-limit.test.ts says the
// same). So the caller is resolved for real, through resolveAgent, the decision is
// made by the real routeRefusal, and the handler's wiring is read from the source it
// runs.

const DRIVER_KEY = "capsid_agent_" + "d".repeat(64);
const LEGACY_WRITE_KEY = "legacy-write-key";
const LEGACY_READ_KEY = "legacy-read-key";
const ROUTES = readFileSync(join(import.meta.dirname, "..", "src", "routes.ts"), "utf8");

function handlerBody(name: string): string {
  const start = ROUTES.indexOf(`async function ${name}(`);
  assert.ok(start !== -1, `${name} not found in src/routes.ts; the scan is reading the wrong file`);
  const next = ROUTES.indexOf("\nasync function ", start + 1);
  const nextConst = ROUTES.indexOf("\nconst ", start + 1);
  const nextExport = ROUTES.indexOf("\nexport ", start + 1);
  const end = Math.min(...[next, nextConst, nextExport].filter((i) => i !== -1));
  return ROUTES.slice(start, end);
}

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

// ---- /ops/backup ----------------------------------------------------------------

test("REPRODUCTION: /ops/backup refuses a one-namespace driver that holds write", async () => {
  const agent = await resolveWith(DRIVER_KEY);
  // The caller is exactly the one the finding describes.
  assert.deepEqual(agent.scopes.namespaces, ["capsid"], "the driver is scoped to one namespace");
  assert.ok(agent.scopes.grants.includes("write"), "the driver holds write");
  assert.equal(agent.admin, false, "the driver is not the admin");

  const refusal = routeRefusal("/ops/backup", agent);
  assert.ok(refusal, "a one-namespace driver was allowed to back up and prune every namespace");
  assert.match(refusal, /admin only/);
  assert.match(refusal, /every namespace/, "the refusal does not say why a backup is admin work");

  const body = handlerBody("handleBackup");
  assert.match(
    body,
    /routeRefusal\("\/ops\/backup", caller\.agent\)/,
    "handleBackup does not ask routeRefusal about its own path, so the table above decides nothing for it"
  );
  assert.doesNotMatch(body, /grants\.includes\(/, "handleBackup decides a grant for itself again (CLAUDE.md rule 6)");
  assert.match(body, /status: 403/, "a resolved caller that is refused should get 403, not 401");
});

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
  assert.equal(routeRefusal("/ops/backup", adminAgent("DrDustinEdwards")), null);
});

test("a path in neither table is refused to everyone but the admin", async () => {
  // routeRefusal fails closed: a route wired to it before its table entry exists is
  // admin only, never open.
  assert.ok(routeRefusal("/ops/not-a-route", await resolveWith(DRIVER_KEY)));
  assert.equal(routeRefusal("/ops/not-a-route", adminAgent("DrDustinEdwards")), null);
});

// ---- every route ----------------------------------------------------------------

const PATH_CONSTANTS: Record<string, string> = {
  REPORT_PATH,
  SCORE_PATH,
  CREDENTIAL_PATH,
  BACKUP_CREDENTIAL_PATH,
  CONSOLE_PATH,
  CONSOLE_JSON_PATH,
  CONSOLE_CALLBACK_PATH,
};

// One entry per dispatch line in defaultHandler: the path it matches and the
// handler it calls.
function dispatches(): { path: string; handler: string }[] {
  const body = ROUTES.slice(ROUTES.indexOf("export const defaultHandler"));
  assert.ok(body.length > 0, "defaultHandler not found in src/routes.ts");
  const found: { path: string; handler: string }[] = [];
  const line = /url\.pathname === ("[^"]+"|[A-Z_]+)[^\n]*?\breturn (\w+)\(/g;
  for (const m of body.matchAll(line)) {
    const raw = m[1];
    let path: string;
    if (raw.startsWith('"')) {
      path = raw.slice(1, -1);
    } else {
      assert.ok(Object.hasOwn(PATH_CONSTANTS, raw), `defaultHandler matches on ${raw}, which this test cannot resolve. Import it into PATH_CONSTANTS.`);
      path = PATH_CONSTANTS[raw];
    }
    found.push({ path, handler: m[2] });
  }
  // A match written any other way (startsWith, a regex, a switch) would be missed by
  // the pattern above and the route would be ungated without anyone deciding it. So
  // every mention of the pathname must be one the pattern read.
  const mentions = body.match(/pathname/g)?.length ?? 0;
  assert.equal(mentions, found.length, `defaultHandler reads url.pathname ${mentions} times and this test parsed ${found.length} dispatch lines`);
  return found;
}

test("every route in defaultHandler is either gated through checkScope or listed as ungated with a reason", () => {
  const routes = dispatches();
  // Measured 2026-09-16: 14 dispatch lines over 12 distinct paths. A change to either
  // number is a route added or removed, and this assertion is where that is noticed.
  assert.equal(routes.length, 14, "the number of dispatch lines in defaultHandler changed");
  const paths = new Set(routes.map((r) => r.path));
  assert.equal(paths.size, 12, "the number of distinct routes changed");

  for (const path of paths) {
    const gated = Object.hasOwn(ROUTE_GRANTS, path);
    const ungated = Object.hasOwn(UNGATED_ROUTES, path);
    assert.ok(gated || ungated, `route ${path} is in neither ROUTE_GRANTS nor UNGATED_ROUTES in src/scope.ts. Decide which.`);
    assert.ok(!(gated && ungated), `route ${path} is in both ROUTE_GRANTS and UNGATED_ROUTES`);
    if (ungated) assert.ok(UNGATED_ROUTES[path].trim().length > 20, `route ${path} is listed as ungated with no real reason`);
  }
  // No stale entry: a table that names a route that no longer exists stops being a
  // statement about this Worker.
  for (const path of [...Object.keys(ROUTE_GRANTS), ...Object.keys(UNGATED_ROUTES)]) {
    assert.ok(paths.has(path), `src/scope.ts names route ${path}, which defaultHandler does not serve`);
  }
});

test("every gated route's handler asks routeRefusal about its own path", () => {
  const gated = dispatches().filter((r) => Object.hasOwn(ROUTE_GRANTS, r.path));
  assert.equal(gated.length, 1, "the number of gated dispatch lines changed");
  for (const { path, handler } of gated) {
    const body = handlerBody(handler);
    assert.ok(
      body.includes(`routeRefusal(${JSON.stringify(path)},`),
      `${handler} serves ${path}, which ROUTE_GRANTS gates, and never calls routeRefusal for it`
    );
  }
});

// ---- the table is the whole statement -------------------------------------------

test("every admin requirement has a reason its refusal can name", () => {
  const admin = [
    ...Object.entries(TOOL_GRANTS).filter(([, r]) => r === "admin").map(([t]) => t),
    ...Object.entries(ROUTE_GRANTS).filter(([, r]) => r === "admin").map(([t]) => t),
    ...Object.entries(TOOL_ACTION_GRANTS)
      .filter(([, spec]) => spec.default === "admin" || Object.values(spec.actions).includes("admin"))
      .map(([t]) => t),
  ];
  assert.equal(admin.length, 5, "the number of admin-only tools and routes changed");
  for (const name of admin) assert.ok(Object.hasOwn(ADMIN_REASON, name), `${name} is admin only and ADMIN_REASON has no entry for it`);
});

test("improve_run: run and claim are a driver's work and every other action is admin", () => {
  const tool = readFileSync(join(import.meta.dirname, "..", "src", "tools", "improve.ts"), "utf8");
  const declared = /action: z\s*\.enum\(\[([^\]]+)\]\)/.exec(tool);
  assert.ok(declared, "improve_run's action enum is gone from src/tools/improve.ts");
  const actions = [...declared[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(actions.length, 9, "improve_run's action list changed");
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
  };
  for (const action of actions) {
    assert.ok(Object.hasOwn(expected, action), `improve_run gained action '${action}'; decide its requirement here and in TOOL_ACTION_GRANTS`);
    assert.equal(requiredForAction("improve_run", action), expected[action], `improve_run.${action}`);
  }
  // An omitted action is a run.
  assert.equal(requiredForAction("improve_run", undefined), "write");
});

test("no tool handler decides admin for itself", () => {
  // agents and improve_run did until 2026-09-16. improve_status passes admin through
  // to shape what it returns, which is not a gate, so the scan looks for the refusal
  // shape: a branch on the identity.
  for (const file of ["agents.ts", "improve.ts"]) {
    const source = readFileSync(join(import.meta.dirname, "..", "src", "tools", file), "utf8");
    assert.doesNotMatch(source, /if \([^)]*!\s*(ctx\.)?agent\.admin/, `src/tools/${file} gates on agent.admin in its handler`);
  }
});
