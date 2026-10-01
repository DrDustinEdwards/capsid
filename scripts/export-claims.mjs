// Export the claims dataset: job_claims, job_evaluations, job_touches and job_outcomes,
// one JSONL file per table, with a manifest that hashes every file.
//
//   CAPSID_OPERATOR_KEY=... node scripts/export-claims.mjs --out <dir>
//   node scripts/export-claims.mjs --verify <dir>
//
// The rows come from the `claims` tool's 'export' action, paged by its cursor until
// next_after is null. The tool is admin only, so the key is the admin credential, an
// OPERATOR_KEY_HASH key. It is read from CAPSID_OPERATOR_KEY and nowhere else: this
// script never reads a file for it, never prints it, and scrubs it from any error it
// reports. CAPSID_ORIGIN picks the Worker and must be https.
//
// WHAT IS WRITTEN. <dir>/<table>.jsonl, one row per line, keys sorted so the same rows
// always produce the same bytes; manifest.json, which names the Worker's deployed sha
// (from /health), the origin, the time, and each file's row count and sha256; and
// manifest.sha256, the manifest's own hash in the form `sha256sum -c` reads. The
// directory must be empty or absent. Every table is read before anything is written,
// so a refusal halfway through leaves no partial export behind.
//
// --verify recomputes every hash and row count and exits 1 on any mismatch or missing
// file. It needs no key.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { capsidClient, requireHttps } from "./capsid-rpc.mjs";

export const ORIGIN_DEFAULT = "https://mcp.dustinedwards.info";

// The four tables of the claims dataset, in the order they are written and listed.
export const EXPORT_TABLES = ["job_claims", "job_evaluations", "job_touches", "job_outcomes"];

// The tool's own bound on one page.
export const PAGE_LIMIT = 500;

const MANIFEST = "manifest.json";
const MANIFEST_SUM = "manifest.sha256";

/** @typedef {Record<string, unknown>} Row */
/** @typedef {(name: string, args: object) => Promise<string>} Tool */
/**
 * @typedef {{
 *   generated_at: string,
 *   origin: string,
 *   capsid_sha: string,
 *   tables: Record<string, { file: string, rows: number, sha256: string }>
 * }} Manifest
 */

/**
 * @param {string | Uint8Array} data
 * @returns {string} lowercase hex
 */
export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    /** @type {Row} */
    const out = {};
    const obj = /** @type {Row} */ (value);
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return value;
}

/**
 * JSON with every object's keys sorted, so the same row always serializes to the same
 * bytes whatever column order the query returned. A null stays null: NULL is not false,
 * and a row that dropped its null columns would read as a different row.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

/**
 * One row per line, each line ending in a newline. No rows is an empty file.
 * @param {Row[]} rows
 * @returns {string}
 */
export function toJsonl(rows) {
  let out = "";
  for (const row of rows) out += canonicalJson(row) + "\n";
  return out;
}

/**
 * The tool's answer for one page: {rows, next_after}. A shape it does not recognize
 * is refused, because a guess here would be an export that silently stops early.
 * @param {string} text
 * @param {string} table
 * @returns {{ rows: Row[], next_after: number | null }}
 */
export function parsePage(text, table) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`claims export of ${table} did not answer with JSON. Raw: ${text.slice(0, 300)}`);
  }
  if (body === null || typeof body !== "object" || !Array.isArray(body.rows)) {
    throw new Error(`claims export of ${table} carried no rows array. Raw: ${text.slice(0, 300)}`);
  }
  for (const [i, row] of body.rows.entries()) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`claims export of ${table}: row ${i} of the page is not an object.`);
    }
  }
  const next = body.next_after;
  if (next !== null && !Number.isSafeInteger(next)) {
    throw new Error(`claims export of ${table}: next_after is ${JSON.stringify(next)}, not an integer or null; the tool's response shape changed.`);
  }
  return { rows: body.rows, next_after: next };
}

/**
 * Every row of one table, pages concatenated in the order the tool served them.
 * A page that does not move the cursor forward is refused rather than looped on.
 * @param {Tool} tool
 * @param {string} table
 * @returns {Promise<Row[]>}
 */
export async function fetchTable(tool, table) {
  /** @type {Row[]} */
  const rows = [];
  /** @type {number | undefined} */
  let after;
  for (;;) {
    /** @type {{ action: string, table: string, limit: number, after?: number }} */
    const args = { action: "export", table, limit: PAGE_LIMIT };
    if (after !== undefined) args.after = after;
    const page = parsePage(await tool("claims", args), table);
    for (const row of page.rows) rows.push(row);
    if (page.next_after === null) return rows;
    if (page.rows.length === 0) {
      throw new Error(`claims export of ${table} returned an empty page with next_after ${page.next_after}; refusing to loop.`);
    }
    if (after !== undefined && page.next_after <= after) {
      throw new Error(`claims export of ${table}: next_after ${page.next_after} does not advance past ${after}; refusing to loop.`);
    }
    after = page.next_after;
  }
}

/**
 * Refuse a path that holds anything. An absent directory is fine; it is created at
 * write time.
 * @param {string} dir
 */
export function ensureEmptyDir(dir) {
  if (!existsSync(dir)) return;
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} exists and is not a directory; refusing to write an export there.`);
  const entries = readdirSync(dir);
  if (entries.length > 0) {
    throw new Error(`${dir} is not empty (${entries.length} entries); refusing to write an export into it. Name a new directory.`);
  }
}

/**
 * The deployed sha from /health, recorded in the manifest so an export says which
 * Worker wrote the rows. A /health that cannot be read fails the export: a manifest
 * with no provenance is not the dataset this script promises.
 * @param {string} origin
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string>}
 */
export async function fetchCapsidSha(origin, fetchImpl = fetch) {
  requireHttps(origin);
  const res = await fetchImpl(`${origin}/health`, { headers: { "Cache-Control": "no-cache" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`/health -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`/health did not answer with JSON. Raw: ${text.slice(0, 300)}`);
  }
  if (typeof body?.sha !== "string" || body.sha.length === 0) {
    throw new Error(`/health carried no sha. Raw: ${text.slice(0, 300)}`);
  }
  return body.sha;
}

/**
 * Read every table, then write the files, the manifest and its hash. Nothing is
 * written until every table has been read.
 * @param {{ tool: Tool, origin: string, capsidSha: string, outDir: string, now?: Date }} opts
 * @returns {Promise<Manifest>}
 */
export async function exportClaims({ tool, origin, capsidSha, outDir, now = new Date() }) {
  ensureEmptyDir(outDir);
  /** @type {Array<{ table: string, rows: number, bytes: Buffer }>} */
  const files = [];
  for (const table of EXPORT_TABLES) {
    const rows = await fetchTable(tool, table);
    files.push({ table, rows: rows.length, bytes: Buffer.from(toJsonl(rows), "utf8") });
  }

  // Checked again: the directory may have filled while the pages were read.
  ensureEmptyDir(outDir);
  mkdirSync(outDir, { recursive: true });

  /** @type {Manifest} */
  const manifest = { generated_at: now.toISOString(), origin, capsid_sha: capsidSha, tables: {} };
  for (const { table, rows, bytes } of files) {
    const file = `${table}.jsonl`;
    writeFileSync(join(outDir, file), bytes, { flag: "wx" });
    manifest.tables[table] = { file, rows, sha256: sha256Hex(bytes) };
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  writeFileSync(join(outDir, MANIFEST), manifestBytes, { flag: "wx" });
  writeFileSync(join(outDir, MANIFEST_SUM), `${sha256Hex(manifestBytes)}  ${MANIFEST}\n`, { flag: "wx" });
  return manifest;
}

/**
 * Every problem with an export directory. An empty list means every file the manifest
 * lists is present with its hash and row count, the manifest matches manifest.sha256,
 * and all four tables are listed.
 * @param {string} dir
 * @returns {string[]}
 */
export function verifyExport(dir) {
  /** @type {string[]} */
  const problems = [];
  const manifestPath = join(dir, MANIFEST);
  if (!existsSync(manifestPath)) return [`${MANIFEST} is missing from ${dir}`];
  const manifestBytes = readFileSync(manifestPath);

  const sumPath = join(dir, MANIFEST_SUM);
  if (!existsSync(sumPath)) {
    problems.push(`${MANIFEST_SUM} is missing`);
  } else {
    const match = /^([0-9a-f]{64}) {2}manifest\.json\n?$/.exec(readFileSync(sumPath, "utf8"));
    if (!match) problems.push(`${MANIFEST_SUM} is not one line of '<sha256>  ${MANIFEST}'`);
    else if (match[1] !== sha256Hex(manifestBytes)) problems.push(`${MANIFEST} does not match the hash in ${MANIFEST_SUM}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    problems.push(`${MANIFEST} is not JSON`);
    return problems;
  }
  const tables = manifest?.tables;
  if (tables === null || typeof tables !== "object" || Array.isArray(tables)) {
    problems.push(`${MANIFEST} lists no tables`);
    return problems;
  }
  for (const table of EXPORT_TABLES) {
    if (!(table in tables)) problems.push(`${MANIFEST} does not list ${table}`);
  }
  for (const [table, entry] of Object.entries(tables)) {
    const file = entry?.file;
    // A plain file name in this directory, never a path out of it.
    if (typeof file !== "string" || file.length === 0 || basename(file) !== file || file === "." || file === "..") {
      problems.push(`${table}: the manifest's file ${JSON.stringify(file)} is not a file name in this directory`);
      continue;
    }
    const path = join(dir, file);
    if (!existsSync(path)) {
      problems.push(`${file} (${table}) is listed in ${MANIFEST} and missing`);
      continue;
    }
    const bytes = readFileSync(path);
    if (sha256Hex(bytes) !== entry.sha256) problems.push(`${file} (${table}) does not match its sha256 in ${MANIFEST}`);
    const lines = bytes.toString("utf8").split("\n").length - 1;
    if (lines !== entry.rows) problems.push(`${file} (${table}) holds ${lines} rows and ${MANIFEST} says ${entry.rows}`);
  }
  return problems;
}

/**
 * Remove every occurrence of the key from text that is about to be printed.
 * @param {string} text
 * @param {string | undefined} key
 * @returns {string}
 */
export function scrub(text, key) {
  if (!key) return text;
  return text.split(key).join("<CAPSID_OPERATOR_KEY>");
}

/**
 * @param {string[]} argv
 * @returns {{ out: string | undefined, verify: string | undefined }}
 */
export function parseArgs(argv) {
  const o = argv.indexOf("--out");
  const v = argv.indexOf("--verify");
  if (o !== -1 && !argv[o + 1]) throw new Error("--out needs a directory, for example --out claims-2026-09-29.");
  if (v !== -1 && !argv[v + 1]) throw new Error("--verify needs the directory an export was written to.");
  if (o !== -1 && v !== -1) throw new Error("--out and --verify are different runs; pass one or the other.");
  if (o === -1 && v === -1) throw new Error("usage: node scripts/export-claims.mjs --out <dir> | --verify <dir>");
  return { out: o === -1 ? undefined : argv[o + 1], verify: v === -1 ? undefined : argv[v + 1] };
}

/**
 * The whole command, with its outputs injected so the test drives it end to end.
 * Returns the exit code. Every line it prints and every error it reports passes
 * through scrub first.
 * @param {{
 *   argv: string[],
 *   env: Record<string, string | undefined>,
 *   fetchImpl?: typeof fetch,
 *   log?: (line: string) => void,
 *   error?: (line: string) => void,
 * }} opts
 * @returns {Promise<number>}
 */
export async function run({ argv, env, fetchImpl = fetch, log = console.log, error = console.error }) {
  const key = env.CAPSID_OPERATOR_KEY;
  /** @param {string} line */
  const out = (line) => log(scrub(line, key));
  /** @param {string} line */
  const err = (line) => error(scrub(line, key));
  try {
    const args = parseArgs(argv);
    if (args.verify !== undefined) {
      const problems = verifyExport(args.verify);
      if (problems.length > 0) {
        err(`verify FAILED for ${args.verify}:`);
        for (const p of problems) err(`  ${p}`);
        return 1;
      }
      out(`verify passed: ${args.verify}, manifest and every listed file match.`);
      return 0;
    }
    const outDir = /** @type {string} */ (args.out);
    if (!key) {
      err("CAPSID_OPERATOR_KEY is not set. It is the admin operator key; this script never reads a file for it.");
      return 2;
    }
    const origin = requireHttps(env.CAPSID_ORIGIN ?? ORIGIN_DEFAULT);
    // Before any request, so a refused directory costs nothing.
    ensureEmptyDir(outDir);
    const client = capsidClient(origin, key, "export-claims", fetchImpl);
    const capsidSha = await fetchCapsidSha(origin, fetchImpl);
    const manifest = await exportClaims({ tool: client.tool, origin, capsidSha, outDir });
    out(`exported to ${outDir} from ${origin} at capsid ${capsidSha}:`);
    for (const [table, entry] of Object.entries(manifest.tables)) {
      out(`  ${table.padEnd(16)} ${String(entry.rows).padStart(7)} rows  sha256 ${entry.sha256.slice(0, 12)}`);
    }
    return 0;
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("export-claims.mjs")) {
  run({ argv: process.argv.slice(2), env: process.env }).then(
    (code) => process.exit(code),
    (e) => {
      // run() catches its own errors, so reaching here is a bug in it. Still scrubbed.
      console.error(scrub(String(e instanceof Error ? e.message : e), process.env.CAPSID_OPERATOR_KEY));
      process.exit(1);
    }
  );
}
