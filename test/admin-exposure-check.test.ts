import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ADMIN_URL, checkAdminExposure, classify, seatKeyPath } from "../scripts/admin-exposure-check.mjs";
// @ts-expect-error a plain .mjs script with no type declarations, imported for its pure helper
import { launchRefusal } from "../scripts/schedule-drivers.mjs";

// job_e1973c5bcb69: a driver session must not be able to reach Capsid as the admin.
// The check reads `claude mcp list`, so these tests feed it that output.

// The shape of today's output, with the servers that matter (names and URLs are public).
const TODAY = [
  "Checking MCP server health...",
  "",
  "claude.ai Capsid: https://mcp.dustinedwards.info/mcp - ✔ Connected",
  "claude.ai Carrel: https://carrel-mcp.dustinedwards.info/mcp - ✔ Connected",
  "claude.ai Dustin Edwards Admin MCP: https://dustinedwards-mcp.dustin-edwards.workers.dev/mcp - ✔ Connected",
  "capsid: https://mcp.dustinedwards.info/ops/mcp (HTTP) - ✔ Connected",
].join("\n");

const run = (stdout: string, status: number | null = 0) => () => ({ status, stdout, stderr: "" });
const none = () => false;

test("the admin connector is flagged and the driver's own /ops/mcp is not, with the count of servers read", () => {
  const { servers_seen, admin_servers } = classify(TODAY);
  assert.equal(servers_seen, 4, "a check that read nothing could not say 0 violations");
  assert.deepEqual(admin_servers, ["claude.ai Capsid"]);
});

test("the retired workers.dev connector URL is flagged too, and its /ops/mcp is not", () => {
  const old = [
    "claude.ai Capsid: https://capsid.dustin-edwards.workers.dev/mcp - ✔ Connected",
    "capsid: https://capsid.dustin-edwards.workers.dev/ops/mcp (HTTP) - ✔ Connected",
  ].join("\n");
  assert.deepEqual(classify(old), { servers_seen: 2, admin_servers: ["claude.ai Capsid"] });
});

test("the pattern ends at /mcp: a longer path and another host are not the admin connector", () => {
  assert.ok(ADMIN_URL.test("https://mcp.dustinedwards.info/mcp"));
  assert.ok(ADMIN_URL.test("x: https://mcp.dustinedwards.info/mcp - ok"));
  assert.ok(!ADMIN_URL.test("https://mcp.dustinedwards.info/ops/mcp"));
  assert.ok(!ADMIN_URL.test("https://mcp.dustinedwards.info/mcp-other"));
  assert.ok(!ADMIN_URL.test("https://carrel-mcp.dustinedwards.info/mcp"));
});

test("a stdio proxy whose command names the connector is flagged", () => {
  const proxied = "bridge: npx mcp-remote https://mcp.dustinedwards.info/mcp - ✔ Connected";
  assert.deepEqual(classify(proxied).admin_servers, ["bridge"]);
});

test("today's machine fails: the connector is loaded", () => {
  const r = checkAdminExposure({ cwd: ".", run: run(TODAY), exists: none });
  assert.equal(r.ok, false);
  assert.deepEqual(r.admin_servers, ["claude.ai Capsid"]);
  assert.match(r.reasons.join(";"), /admin connector is loaded/);
});

test("a folder with only the driver's server and no seat key passes", () => {
  const clean = TODAY.split("\n").filter((l) => !l.startsWith("claude.ai Capsid")).join("\n");
  const r = checkAdminExposure({ cwd: ".", run: run(clean), exists: none });
  assert.equal(r.ok, true);
  assert.equal(r.servers_seen, 3);
  assert.deepEqual(r.reasons, []);
});

test("the seat key on disk fails an otherwise clean folder, at the path under ~/.capsid", () => {
  const seen: string[] = [];
  const clean = "capsid: https://mcp.dustinedwards.info/ops/mcp (HTTP) - ✔ Connected";
  const r = checkAdminExposure({ cwd: ".", run: run(clean), exists: (p: string) => (seen.push(p), true), home: "H" });
  assert.equal(r.ok, false);
  assert.equal(r.seat_key_present, true);
  assert.deepEqual(seen, [seatKeyPath("H")]);
  assert.match(seatKeyPath("H"), /[\\/]\.capsid[\\/]agent-seat\.key$/);
});

test("it fails closed: a claude that cannot run, exits non-zero, or lists nothing is not a pass", () => {
  const cannot = checkAdminExposure({ cwd: ".", run: () => ({ status: null, error: new Error("spawn claude ENOENT") }), exists: none });
  assert.equal(cannot.ok, false);
  assert.match(cannot.reasons[0], /could not run: spawn claude ENOENT/);

  const failed = checkAdminExposure({ cwd: ".", run: run("", 1), exists: none });
  assert.equal(failed.ok, false);
  assert.match(failed.reasons[0], /exited 1/);

  const empty = checkAdminExposure({ cwd: ".", run: run("Checking MCP server health...\n"), exists: none });
  assert.equal(empty.ok, false);
  assert.equal(empty.servers_seen, 0);
  assert.match(empty.reasons[0], /listed no server/);
});

test("the result carries names and booleans, never a URL", () => {
  const r = checkAdminExposure({ cwd: ".", run: run(TODAY), exists: none });
  assert.ok(!JSON.stringify(r).includes("https://"));
});

// The scheduler refuses before it starts a driver.

test("launchRefusal returns the reason when the check fails and null when it passes", () => {
  const bad = launchRefusal("F", () => ({ ok: false, reasons: ["the admin connector is loaded: claude.ai Capsid"] }));
  assert.match(bad, /^refused to launch the driver: .*claude\.ai Capsid/);
  assert.equal(launchRefusal("F", () => ({ ok: true, reasons: [] })), null);
});

test("runOne checks the folder before it spawns the driver", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "scripts", "schedule-drivers.mjs"), "utf8");
  const body = src.slice(src.indexOf("async function runOne"));
  const check = body.indexOf("launchRefusal(folder)");
  const spawn = body.indexOf('spawnSync("claude"');
  assert.ok(check > 0, "runOne never calls launchRefusal");
  assert.ok(spawn > check, "the driver is spawned before the exposure check");
});
