// KEEP A WORKING DRIVER'S LEASE ALIVE (job_3637b6291785, Dustin 2026-10-07). A driver that
// hands a build to a background subagent can go hours without a turn of its own, so it
// cannot heartbeat on a timer, and the four-hour lease would return a job that is being
// worked. Claude Code has no timer hook, but PostToolUse fires for every tool call a
// subagent makes too (the input then carries agent_id), so this runs as an async
// PostToolUse hook and sends the heartbeat itself, at most once every ten minutes.
//
// A SESSION THAT DIED MAKES NO TOOL CALLS, SO NO HOOK FIRES, AND ITS LEASE STILL EXPIRES.
// That is the point of choosing the hook over a longer lease or a Worker that guesses.
//
// What it does, quietly and never in the way:
//   1. Reads the hook's stdin JSON (session_id, cwd). Absent or unreadable: does nothing.
//   2. Throttles on a stamp file per session, so a thousand tool calls send a handful of requests.
//   3. Finds the driver key in the project's .mcp.json (the capsid server). No file, no
//      key, a non-https url: does nothing, so it is safe to install for every session.
//   4. Calls improve_status, which a scoped driver can call without naming a namespace and
//      which lists each claimed job, then heartbeats every claimed job in its namespaces.
//      The Worker refuses a heartbeat from anyone who is not the holder, and those
//      refusals are expected and ignored.
//   5. Always exits 0 and prints nothing. The key goes only in the Authorization header.
//
// Installed once, by Dustin, in the user-level Claude Code settings (an agent cannot edit
// them): see docs/work-queue.md, "Keeping a working lease alive".

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { capsidClient } from "./capsid-rpc.mjs";

/** Ten minutes: far under the four-hour lease, far over the rate of a busy session's tool calls. */
export const THROTTLE_MS = 10 * 60_000;

/**
 * The capsid server's origin and key from the nearest .mcp.json at or above `start`.
 * @param {string} start
 * @returns {{ origin: string, key: string } | null}
 */
export function findCredentials(start) {
  let dir = resolve(start);
  for (;;) {
    const file = join(dir, ".mcp.json");
    if (existsSync(file)) {
      try {
        const servers = JSON.parse(readFileSync(file, "utf8")).mcpServers ?? {};
        const entry = servers.capsid ?? Object.values(servers).find((s) => typeof s?.url === "string" && s.url.includes("/ops/mcp"));
        const auth = entry?.headers?.Authorization;
        if (entry?.url && typeof auth === "string" && auth.startsWith("Bearer ")) {
          return { origin: new URL(entry.url).origin, key: auth.slice("Bearer ".length).trim() };
        }
      } catch {
        return null;
      }
      return null;
    }
    const up = dirname(dir);
    if (up === dir || dir === parse(dir).root) return null;
    dir = up;
  }
}

/**
 * Every claimed job listed in an improve_status answer, as { id, namespace }.
 * @param {string} statusText
 * @returns {Array<{ id: string, namespace: string }>}
 */
export function claimedJobs(statusText) {
  /** @type {any} */
  let status;
  try {
    status = JSON.parse(statusText);
  } catch {
    return [];
  }
  /** @type {Array<{ id: string, namespace: string }>} */
  const out = [];
  for (const ns of status?.namespaces ?? []) {
    for (const job of ns?.jobs?.claimed_jobs ?? []) {
      if (typeof job?.id === "string" && typeof ns?.namespace === "string") out.push({ id: job.id, namespace: ns.namespace });
    }
  }
  return out;
}

/**
 * One keep-alive pass. Returns what it did, for the tests; the CLI ignores it.
 * @param {{ input: string, env: Record<string, string | undefined>, fetchImpl?: typeof fetch, now?: number, stampDir?: string }} opts
 * @returns {Promise<{ sent: number, skipped: string | null }>}
 */
export async function keepAlive({ input, env, fetchImpl = fetch, now = Date.now(), stampDir = tmpdir() }) {
  /** @type {any} */
  let hook;
  try {
    hook = JSON.parse(input);
  } catch {
    return { sent: 0, skipped: "no hook input" };
  }
  const session = typeof hook?.session_id === "string" ? hook.session_id : "";
  if (!session) return { sent: 0, skipped: "no session id" };

  const stamp = join(stampDir, `capsid-keepalive-${createHash("sha256").update(session).digest("hex").slice(0, 16)}.stamp`);
  try {
    if (now - statSync(stamp).mtimeMs < THROTTLE_MS) return { sent: 0, skipped: "throttled" };
  } catch {
    // no stamp yet
  }

  const start = env.CLAUDE_PROJECT_DIR || (typeof hook?.cwd === "string" ? hook.cwd : "");
  const creds = start ? findCredentials(start) : null;
  if (!creds) return { sent: 0, skipped: "no capsid key in .mcp.json" };

  // Stamped before the calls, so a slow or failing Worker does not make every tool call retry.
  try {
    writeFileSync(stamp, String(now));
  } catch {
    return { sent: 0, skipped: "could not write the stamp" };
  }

  try {
    const client = capsidClient(creds.origin, creds.key, "lease-keepalive", fetchImpl);
    const jobs = claimedJobs(await client.tool("improve_status", {}));
    let sent = 0;
    for (const job of jobs) {
      try {
        await client.tool("jobs", { action: "heartbeat", id: job.id, namespace: job.namespace, reason: "ok: kept alive by the PostToolUse hook while the session works" });
        sent++;
      } catch {
        // not this session's job: the Worker refuses a heartbeat from a non-holder
      }
    }
    return { sent, skipped: null };
  } catch {
    return { sent: 0, skipped: "the Worker could not be reached" };
  }
}

async function main() {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const timer = setTimeout(() => process.exit(0), 20_000);
  try {
    await keepAlive({ input: Buffer.concat(chunks).toString("utf8"), env: process.env });
  } catch {
    // never in the way
  }
  clearTimeout(timer);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
