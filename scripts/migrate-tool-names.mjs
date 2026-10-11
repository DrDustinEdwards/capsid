#!/usr/bin/env node
// The MCP 4 regroup's data migration, run by the seat with the admin operator key. The
// pure rules are scripts/tool-names-lib.mjs. Three phases, in this order:
//
//   1. add    BEFORE the deploy, against the live (old) Worker. Each agent's tools axis
//             gains the new names beside the old ones, so it works on the old Worker now,
//             on the new one after the deploy (gate 8's live-probe agent included), and
//             on the old one again after a rollback.
//   2. prose  AFTER the deploy, against the new Worker. Rewrites old tool names in the
//             body of every queued and blocked job (re-signed by the edit), every skill
//             (improve/skills/*.md) and the canon docs (capsid/conventions*.md,
//             capsid/repo-structure.md, every namespace's core.md). The decisions logs
//             are records of what was ruled when, and are not rewritten.
//   3. prune  After the soak, against the new Worker. Removes the old names.
//
// DRY RUN BY DEFAULT: each phase prints what it would change and writes nothing. Pass
// --apply to write. Every write goes through the Worker's own tools, so each is scoped,
// snapshotted and audited as any other.
//
//   CAPSID_OPERATOR_KEY=... node scripts/migrate-tool-names.mjs --phase add [--surface old|new] [--apply]
//
// The key goes into the Authorization header and nowhere else. It is never printed.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { capsidClient, requireHttps } from "./capsid-rpc.mjs";
import { addedToolsAxis, prunedToolsAxis, rewriteProse, unsignedBody } from "./tool-names-lib.mjs";

const ORIGIN_DEFAULT = "https://mcp.dustinedwards.info";
const PHASES = ["add", "prose", "prune"];

// The two surfaces' spellings of the calls this script makes.
const SURFACES = {
  old: {
    route: "/ops/mcp",
    agents: (/** @type {object} */ args) => ["agents", args],
  },
  new: {
    route: "/ops/mcp/admin",
    agents: (/** @type {object} */ args) => ["capsid_admin_manage_agents", args],
  },
};

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ phase?: string, surface?: string, apply: boolean }} */
  const out = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--phase") out.phase = argv[++i];
    else if (a === "--surface") out.surface = argv[++i];
    else throw new Error(`unknown argument '${a}'`);
  }
  if (!out.phase || !PHASES.includes(out.phase)) throw new Error(`--phase must be one of ${PHASES.join(", ")}`);
  out.surface ??= out.phase === "add" ? "old" : "new";
  if (!Object.hasOwn(SURFACES, out.surface)) throw new Error("--surface must be old or new");
  if (out.phase !== "add" && out.surface !== "new") throw new Error(`--phase ${out.phase} runs against the new Worker only`);
  return out;
}

/**
 * @typedef {(name: string, args: object) => Promise<string>} Tool
 * @typedef {(line: string) => void} Out
 */

/**
 * Phases add and prune: the agents' tools axes.
 * @param {Tool} tool
 * @param {"old" | "new"} surface
 * @param {"add" | "prune"} phase
 * @param {boolean} apply
 * @param {Out} out
 */
export async function migrateAxes(tool, surface, phase, apply, out) {
  const s = SURFACES[surface];
  const listed = JSON.parse(await tool(...s.agents({ action: "list" })));
  /** @type {Array<{ name: string, revoked_at: string | null, scopes: { tools: "*" | string[] } }>} */
  const agents = listed.agents ?? [];
  let changed = 0;
  for (const agent of agents) {
    if (agent.revoked_at) continue;
    const before = agent.scopes.tools;
    const after = phase === "add" ? addedToolsAxis(before) : prunedToolsAxis(before);
    if (JSON.stringify(after) === JSON.stringify(before)) continue;
    changed++;
    out(`${agent.name}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    if (apply) await tool(...s.agents({ action: "update_scopes", name: agent.name, tools: after }));
  }
  out(`${changed} agent(s) ${apply ? "updated" : "would change"}.`);
  return changed;
}

/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * @param {ReturnType<typeof rewriteProse>} r
 * @param {string} where
 * @param {Out} out
 */
function report(r, where, out) {
  for (const c of r.changes) out(`${where}:${c.line}\n  - ${c.before.trim()}\n  + ${c.after.trim()}`);
  for (const u of r.unmapped) out(`${where}:${u.line} NOT REWRITTEN, no mapping: ${u.text}`);
  for (const a of r.ambiguous) out(`${where}:${a.line} NOT REWRITTEN, may not be the tool: ${a.text}`);
  for (const f of r.fenced) out(`${where}:${f.line} in a code block, left for the seat: ${f.text.trim()}`);
}

/**
 * Phase prose: job bodies, skills and canon docs, on the new Worker.
 * @param {Tool} tool the Capsid client (/ops/mcp)
 * @param {boolean} apply
 * @param {Out} out
 */
export async function migrateProse(tool, apply, out) {
  let changed = 0;
  // Jobs: queued and blocked are the bodies a driver will still be handed.
  for (const status of ["queued", "blocked"]) {
    const listed = JSON.parse(await tool("capsid_work_jobs", { action: "list", status }));
    if (listed.truncated) out(`WARNING: the ${status} list is truncated; run again after these are rewritten.`);
    for (const row of listed.jobs ?? []) {
      const one = JSON.parse(await tool("capsid_work_jobs", { action: "list", id: row.id }));
      const stored = one.jobs?.[0]?.body;
      if (typeof stored !== "string") {
        out(`${row.id}: NO BODY returned (this key cannot read it), skipped`);
        continue;
      }
      const body = unsignedBody(stored);
      const r = rewriteProse(body);
      report(r, `job ${row.id}`, out);
      if (r.changes.length === 0) continue;
      changed++;
      if (apply) await tool("capsid_work_jobs", { action: "edit", id: row.id, body: r.text });
    }
  }
  // Documents.
  const namespaces = JSON.parse(await tool("capsid_find_docs", { action: "namespaces" }));
  /** @type {string[]} */
  const names = (Array.isArray(namespaces) ? namespaces : namespaces.namespaces ?? []).map((/** @type {{ namespace: string }} */ n) => n.namespace);
  /** @type {Array<{ namespace: string, path: string, improve: boolean }>} */
  const docs = [];
  for (const namespace of names) {
    docs.push({ namespace, path: "core.md", improve: false });
    const skills = JSON.parse(await tool("capsid_find_docs", { action: "glob", namespace, glob: "improve/skills/*.md" }));
    for (const d of skills.documents ?? []) docs.push({ namespace, path: d.path, improve: true });
  }
  const canon = JSON.parse(await tool("capsid_find_docs", { action: "glob", namespace: "capsid", glob: "conventions*.md" }));
  for (const d of canon.documents ?? []) docs.push({ namespace: "capsid", path: d.path, improve: false });
  docs.push({ namespace: "capsid", path: "repo-structure.md", improve: false });

  for (const doc of docs) {
    let row;
    try {
      row = JSON.parse(await tool("capsid_read_doc", { namespace: doc.namespace, path: doc.path }));
    } catch (err) {
      if (/not found/.test(String(err))) continue;
      throw err;
    }
    if (typeof row.body !== "string") continue;
    const r = rewriteProse(row.body);
    report(r, `${doc.namespace}/${doc.path}`, out);
    if (r.changes.length === 0) continue;
    changed++;
    if (apply) {
      await tool("capsid_write_doc", {
        namespace: doc.namespace,
        path: doc.path,
        title: row.title ?? doc.path,
        body: r.text,
        confirm: true,
        // Refused when the doc changed since it was read, so nothing is overwritten unseen.
        if_match: sha256(row.body),
        ...(doc.improve ? { allow_improve_paths: true } : {}),
      });
    }
  }
  out(`${changed} job(s) and document(s) ${apply ? "rewritten" : "would change"}.`);
  return changed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = process.env.CAPSID_OPERATOR_KEY;
  if (!key) {
    console.error("CAPSID_OPERATOR_KEY is not set. It is the admin operator key; this script never reads a file for it.");
    process.exit(2);
  }
  const origin = requireHttps(process.env.CAPSID_ORIGIN ?? ORIGIN_DEFAULT);
  const out = (/** @type {string} */ line) => console.log(line);
  out(`${args.apply ? "APPLYING" : "DRY RUN (pass --apply to write)"}: phase ${args.phase} against ${origin} (${args.surface} surface)`);
  if (args.phase === "prose") {
    const client = capsidClient(origin, key, "migrate-tool-names");
    await migrateProse(client.tool, args.apply, out);
  } else {
    const surface = /** @type {"old" | "new"} */ (args.surface);
    const route = /** @type {"/ops/mcp" | "/ops/mcp/admin"} */ (SURFACES[surface].route);
    const client = capsidClient(origin, key, "migrate-tool-names", fetch, route);
    await migrateAxes(client.tool, surface, /** @type {"add" | "prune"} */ (args.phase), args.apply, out);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
