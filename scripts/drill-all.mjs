// Proves every site's backups at once, from the seat's machine.
//
//   node scripts/drill-all.mjs [--site <name>]...
//
// For each site it opens the site's backup bucket with the caller's own wrangler login
// (npx wrangler login; no token is read, passed or printed), downloads the newest
// COMPLETE run, restores it with d1-dump's drill into a local SQLite file, and prints
// one line: `<site> run=<id> age_hours=<n> tables=<n> rows=<n> PASS`, or the same with
// `FAIL (<reason>)`. Exit code 1 when any site failed, 2 for a bad argument. docs/backups.md, "Drill every site".
//
// `wrangler r2 object` has no list command, so the bucket is opened through wrangler's
// getPlatformProxy with a temporary config declaring one remote R2 binding.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMPLETE_MARKER, latestDump } from "@dustinedwards/d1-dump";

// txasm, dustinedwards and foxing join this list as their backup jobs land
// (job_cf5cafaa8c52, job_e40ec706c10a, job_d087b66eef22).
export const SITES = [
  { name: "foxhound", bucket: "foxhound-backups" },
  { name: "carrel", bucket: "carrel-backups" },
  { name: "germomics", bucket: "germomics-backups" },
];

// The drill's own freshness threshold (d1-dump DEFAULT_STALE_HOURS). Checked here against
// `now`, and the drill runs with --max-age-hours off, so the line's age and its verdict
// read one clock.
const MAX_AGE_HOURS = 26;
// A drill that runs longer than this is a FAIL line, not a hang of every later site.
const DRILL_TIMEOUT_MS = 15 * 60_000;

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@dustinedwards", "d1-dump", "dist", "cli.js");

/** The real drill: d1-dump's CLI on the sqlite backend, as a child process. */
export function runDrillCli(dir, prefix) {
  const r = spawnSync(process.execPath, [CLI, "drill", "--dir", dir, "--backend", "sqlite", "--prefix", prefix, "--max-age-hours", "off"], {
    encoding: "utf8",
    timeout: DRILL_TIMEOUT_MS,
  });
  const killed = r.signal ? `FAIL drill: stopped by ${r.signal} (timeout ${DRILL_TIMEOUT_MS / 60_000} min)\n` : "";
  return { code: r.status ?? 1, output: `${killed}${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error.message) : ""}` };
}

/** The first failing check of a drill's output, or its first line when none is named. */
export function firstFailure(output) {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const failed = lines.find((l) => l.startsWith("FAIL "));
  return (failed ?? lines.find((l) => !l.startsWith("backend:")) ?? "the drill printed nothing").replace(/^FAIL /, "").slice(0, 200);
}

async function listAll(bucket, prefix) {
  const keys = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/**
 * Drills one site's bucket. Never throws: a bucket that cannot be read, or no complete
 * run, is a FAIL line. Returns { line, ok }.
 */
export async function drillSite(site, bucket, { now = new Date(), runDrill = runDrillCli } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `drill-${site}-`));
  let head = site;
  try {
    const latest = await latestDump(bucket);
    if (!latest) return { line: `${site} FAIL (no complete run found)`, ok: false };
    head = `${site} run=${latest.run_id}`;
    const keys = await listAll(bucket, latest.prefix);
    const root = resolve(dir) + sep;
    for (const key of keys) {
      const path = resolve(dir, ...key.split("/"));
      if (!path.startsWith(root)) throw new Error(`${key} resolves outside the download directory`);
      const obj = await bucket.get(key);
      if (!obj) throw new Error(`${key} listed but not readable`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, await obj.text());
    }
    const marker = JSON.parse(readFileSync(join(dir, ...latest.prefix.split("/"), COMPLETE_MARKER), "utf8"));
    const age = Math.round(((now.getTime() - Date.parse(latest.exported_at)) / 3_600_000) * 10) / 10;
    const tables = Array.isArray(marker.tables) ? marker.tables : [];
    const rows = tables.reduce((n, t) => n + (Number.isFinite(t?.rows) ? t.rows : 0), 0);
    const stats = `${head} age_hours=${Number.isNaN(age) ? "unknown" : age.toFixed(1)} tables=${tables.length} rows=${rows}`;
    if (Number.isNaN(age)) return { line: `${stats} FAIL (dump: exported_at is not a time)`, ok: false };
    if (age > MAX_AGE_HOURS) return { line: `${stats} FAIL (dump: the newest complete run is over ${MAX_AGE_HOURS}h old)`, ok: false };
    const { code, output } = await runDrill(dir, latest.prefix);
    return code === 0 ? { line: `${stats} PASS`, ok: true } : { line: `${stats} FAIL (${firstFailure(output)})`, ok: false };
  } catch (err) {
    return { line: `${head} FAIL (${(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 200)})`, ok: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The sites named by --site flags, or all of them; an unknown name or argument is an error. */
export function selectSites(argv, sites = SITES) {
  const wanted = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--site") throw new Error(`unknown argument ${argv[i]}; usage: node scripts/drill-all.mjs [--site <name>]...`);
    const name = argv[++i];
    if (!name) throw new Error("--site needs a site name");
    wanted.push(name);
  }
  if (wanted.length === 0) return sites;
  const unknown = wanted.filter((w) => !sites.some((s) => s.name === w));
  if (unknown.length > 0) throw new Error(`unknown site ${unknown.join(", ")}; known: ${sites.map((s) => s.name).join(", ")}`);
  return sites.filter((s) => wanted.includes(s.name));
}

// Opens the site's bucket through the caller's wrangler login. Returns the bucket and a dispose.
async function openBucket(site) {
  const { getPlatformProxy } = await import("wrangler");
  const cfgDir = mkdtempSync(join(tmpdir(), `drill-cfg-${site.name}-`));
  const configPath = join(cfgDir, "wrangler.jsonc");
  writeFileSync(configPath, JSON.stringify({ name: "drill-all", compatibility_date: "2026-01-01", r2_buckets: [{ binding: "BACKUPS", bucket_name: site.bucket, remote: true }] }));
  let proxy;
  try {
    proxy = await getPlatformProxy({ configPath, remoteBindings: true, persist: false });
  } catch (err) {
    rmSync(cfgDir, { recursive: true, force: true });
    throw err;
  }
  return {
    bucket: proxy.env.BACKUPS,
    dispose: async () => {
      try {
        await proxy.dispose();
      } finally {
        rmSync(cfgDir, { recursive: true, force: true });
      }
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  let sites;
  try {
    sites = selectSites(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  let failed = false;
  for (const site of sites) {
    let opened;
    try {
      opened = await openBucket(site);
    } catch (err) {
      console.log(`${site.name} FAIL (cannot open ${site.bucket}: ${(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 160)})`);
      failed = true;
      continue;
    }
    try {
      const { line, ok } = await drillSite(site.name, opened.bucket);
      console.log(line);
      if (!ok) failed = true;
    } finally {
      await opened.dispose().catch(() => undefined);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(await main());
