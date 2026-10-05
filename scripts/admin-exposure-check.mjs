// Fails when a driver session on this machine could reach Capsid as the admin.
//
//   node scripts/admin-exposure-check.mjs [--cwd <project folder>]
//
// Two exposures, both measured from the folder a driver would start in:
//
//   1. The claude.ai Capsid connector is listed by `claude mcp list`. Claude Code
//      fetches it from the claude.ai login, and Capsid resolves it to the admin. A
//      driver must reach Capsid only through its own key on /ops/mcp.
//   2. ~/.capsid/agent-seat.key exists. It carries can_merge and every session under
//      this Windows account can read it (job_e1973c5bcb69, DECIDE 3).
//
// It fails closed: if `claude mcp list` cannot run, exits non-zero, or lists no
// server, the answer is "unknown", which is a failure, never a pass. It prints server
// names and booleans, never a URL, a header or a key.
//
// The connector URL is the exact /mcp path. The driver's /ops/mcp on the same host is
// the one allowed route, so a pattern that matched the host alone would flag it.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The live host, and the retired workers.dev one in case the connector still carries
// it (PR #227 moved the endpoint). `/mcp` must end the URL or be followed by a
// character that cannot continue a path segment, so /ops/mcp never matches.
export const ADMIN_URL = /https:\/\/(?:mcp\.dustinedwards\.info|capsid\.dustin-edwards\.workers\.dev)\/mcp(?![A-Za-z0-9_./-])/;

// `claude mcp list` prints one `name: target - status` line per server.
const SERVER_LINE = /^(.+?): (.+?) - \S/;

export const seatKeyPath = (home = homedir()) => join(home, ".capsid", "agent-seat.key");

/**
 * @param {string} text the stdout of `claude mcp list`
 * @returns {{ servers_seen: number; admin_servers: string[] }}
 */
export function classify(text) {
  /** @type {string[]} */
  const admin = [];
  let seen = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = SERVER_LINE.exec(line);
    if (!m) continue;
    seen += 1;
    // The whole line is tested, not only a parsed URL, so a stdio proxy whose command
    // line names the connector is caught as well.
    if (ADMIN_URL.test(line)) admin.push(m[1]);
  }
  return { servers_seen: seen, admin_servers: admin };
}

/**
 * @typedef {{ status: number | null; stdout?: string | null; stderr?: string | null; error?: Error }} Run
 * @param {{ cwd: string; run?: (cwd: string) => Run; exists?: (path: string) => boolean; home?: string }} opts
 * @returns {{ ok: boolean; servers_seen: number; admin_servers: string[]; seat_key_present: boolean; reasons: string[] }}
 */
export function checkAdminExposure({
  cwd,
  run = (dir) => spawnSync("claude", ["mcp", "list"], { cwd: dir, encoding: "utf8", timeout: 120_000 }),
  exists = existsSync,
  home = homedir(),
}) {
  /** @type {string[]} */
  const reasons = [];
  const res = run(cwd);
  let servers_seen = 0;
  /** @type {string[]} */
  let admin_servers = [];
  if (res.error) reasons.push(`claude mcp list could not run: ${res.error.message}`);
  else if (res.status !== 0) reasons.push(`claude mcp list exited ${res.status}`);
  else {
    ({ servers_seen, admin_servers } = classify(res.stdout ?? ""));
    if (servers_seen === 0) reasons.push("claude mcp list listed no server, so nothing was checked");
    if (admin_servers.length > 0) reasons.push(`the admin connector is loaded: ${admin_servers.join(", ")}`);
  }
  const seat_key_present = exists(seatKeyPath(home));
  if (seat_key_present) reasons.push("agent-seat.key is on disk");
  return { ok: reasons.length === 0, servers_seen, admin_servers, seat_key_present, reasons };
}

function main() {
  const i = process.argv.indexOf("--cwd");
  const cwd = i >= 0 ? process.argv[i + 1] : process.cwd();
  if (!cwd) throw new Error("--cwd needs a folder.");
  const result = checkAdminExposure({ cwd });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

// Only when executed, so the pure helpers above are importable by the test suite.
if (process.argv[1] && process.argv[1].endsWith("admin-exposure-check.mjs")) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
