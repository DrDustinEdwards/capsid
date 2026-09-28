// Size budget for the built app. Run after `npm run build`. Fails closed: a missing
// dist/, a missing or unreadable manifest, a manifest with no entry, or any file over
// its budget exits non-zero.
//
//   initial JS (the entry and its static imports)  <= 100 KB gzip
//   each lazy chunk (reached by dynamic import)     <=  40 KB gzip
//   all CSS                                         <=  12 KB gzip
//   fonts                                           reported, not budgeted
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const KB = 1024;
const BUDGET = { initialJs: 100 * KB, lazyChunk: 40 * KB, css: 12 * KB };

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const manifestPath = join(dist, ".vite", "manifest.json");

function fail(msg) {
  console.error(`size-budget: FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(dist)) fail(`no dist/ at ${dist}; run npm run build first`);
if (!existsSync(manifestPath)) fail(`no manifest at ${manifestPath}; vite.config.ts must set build.manifest`);

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (e) {
  fail(`manifest is unreadable: ${e instanceof Error ? e.message : String(e)}`);
}

const entries = Object.entries(manifest).filter(([, c]) => c.isEntry);
if (entries.length === 0) fail("the manifest names no entry chunk");

function sizeOf(rel) {
  const p = join(dist, rel);
  if (!existsSync(p)) fail(`the manifest names ${rel}, which is not in dist/`);
  const buf = readFileSync(p);
  return { raw: buf.length, gz: gzipSync(buf, { level: 9 }).length };
}

// Initial JS: every entry and everything it imports statically.
const initial = new Set();
const walk = (key) => {
  const c = manifest[key];
  if (!c) fail(`the manifest has no chunk ${key}`);
  if (initial.has(c.file)) return;
  initial.add(c.file);
  for (const k of c.imports ?? []) walk(k);
};
for (const [key] of entries) walk(key);

// Lazy chunks: JS reached only through a dynamic import.
const lazy = new Set();
for (const c of Object.values(manifest)) {
  for (const k of c.dynamicImports ?? []) {
    const f = manifest[k]?.file;
    if (f && !initial.has(f)) lazy.add(f);
  }
}

const assetsDir = join(dist, "assets");
if (!existsSync(assetsDir)) fail("no dist/assets/");
const files = readdirSync(assetsDir).map((f) => `assets/${f}`);
const css = files.filter((f) => f.endsWith(".css"));
const fonts = files.filter((f) => /\.(woff2?|ttf|otf)$/.test(f));
const jsInitial = [...initial].filter((f) => f.endsWith(".js"));
const unaccounted = files.filter((f) => f.endsWith(".js") && !initial.has(f) && !lazy.has(f));
if (jsInitial.length === 0) fail("no initial JS found through the manifest");

const rows = [];
const problems = [];
const fmt = (n) => `${(n / KB).toFixed(1)} KB`;

let initialGz = 0;
for (const f of jsInitial) {
  const s = sizeOf(f);
  initialGz += s.gz;
  rows.push(["initial js", f, s.raw, s.gz, ""]);
}
rows.push(["initial js", "TOTAL", null, initialGz, `<= ${fmt(BUDGET.initialJs)}`]);
if (initialGz > BUDGET.initialJs) problems.push(`initial JS is ${fmt(initialGz)} gzip, over ${fmt(BUDGET.initialJs)}`);

for (const f of [...lazy, ...unaccounted]) {
  const s = sizeOf(f);
  rows.push(["lazy js", f, s.raw, s.gz, `<= ${fmt(BUDGET.lazyChunk)}`]);
  if (s.gz > BUDGET.lazyChunk) problems.push(`lazy chunk ${f} is ${fmt(s.gz)} gzip, over ${fmt(BUDGET.lazyChunk)}`);
}

let cssGz = 0;
for (const f of css) {
  const s = sizeOf(f);
  cssGz += s.gz;
  rows.push(["css", f, s.raw, s.gz, ""]);
}
rows.push(["css", "TOTAL", null, cssGz, `<= ${fmt(BUDGET.css)}`]);
if (cssGz > BUDGET.css) problems.push(`CSS is ${fmt(cssGz)} gzip, over ${fmt(BUDGET.css)}`);

let fontRaw = 0;
for (const f of fonts) fontRaw += sizeOf(f).raw;
rows.push(["fonts", `${fonts.length} files (not budgeted)`, fontRaw, null, "reported"]);

const w = [10, Math.max(...rows.map((r) => r[1].length)), 10, 10, 12];
const line = (c) => [c[0].padEnd(w[0]), c[1].padEnd(w[1]), c[2].padStart(w[2]), c[3].padStart(w[3]), c[4].padEnd(w[4])].join("  ");
console.log(line(["kind", "file", "raw", "gzip", "budget"]));
console.log(line(["-".repeat(w[0]), "-".repeat(w[1]), "-".repeat(w[2]), "-".repeat(w[3]), "-".repeat(w[4])]));
for (const r of rows) console.log(line([r[0], r[1], r[2] == null ? "" : fmt(r[2]), r[3] == null ? "" : fmt(r[3]), r[4]]));

if (problems.length) {
  for (const p of problems) console.error(`size-budget: FAIL: ${p}`);
  process.exit(1);
}
console.log("size-budget: pass");
