// Size budget for the built app. Run after `npm run build`. Fails closed: a missing
// dist/, a missing or unreadable manifest, a manifest with no entry, or any file over
// its budget exits non-zero.
//
//   initial JS (the entry and its static imports)  <= 121 KB gzip
//   each lazy chunk (reached by dynamic import)     <=  40 KB gzip
//   initial CSS (the entry's and its imports')      <=  23 KB gzip
//   lazy CSS (every other stylesheet), together     <=  12 KB gzip
//   fonts                                           reported, not budgeted
//
// Raised on 2026-10-07 from 100 KB JS and 12 KB CSS (Dustin, after capsid #261): the shell is
// Capsomer's AdminShell, which carries the strip of apps and tools, the account panel and the
// phone sheet, beside the command menu the entry already held. The first AdminShell build was
// 102.8 KB JS and 12.6 KB CSS; the new limits leave room above that, not for more.
//
// CSS raised on 2026-10-11 from 13 KB to 15 KB (Dustin: "raise the CSS budget in that PR as
// needed", job_d62abdbfc270 PR 6): the charts are Enarratio's, and its base stylesheet
// (enarratio/base.css, 2.1 KB gzip) comes with them, beside the variables that map it to the
// Portal's tokens. Master was 13.0 KB; this build is 14.3 KB. The JS limits are unchanged.
//
// Initial JS raised on 2026-10-14 from 105 KB to 110 KB (job_263c8ce67053): Capsomer 0.9.0's
// owner shell puts the site header in the entry (its account menu, phone sheet, theme button
// and the shared popover and dialog behind them), 8.2 KB gzip over master's 104.4 KB. The
// drawer and the command menu moved out of the entry to pay back 4.4 KB; this build is 108.2 KB.
// CSS raised the same day from 15 KB to 18 KB: the header's stylesheets (site-header,
// theme-switch, popover) load beside admin-shell.css, as Capsomer requires; this build is 17.0 KB.
// CSS raised on 2026-10-20 from 18 KB to 18.5 KB (Portal UX audit M7 and M8, capsid #476): the
// contrast and link-underline rules and Capsomer 0.9.1's 320px header rules put the build 53 bytes
// over; this build is 18.05 KB.
// Initial JS raised on 2026-10-24 from 110 KB to 115 KB (Dustin: move the Portal's data and
// polling onto TanStack Query, as Foxing's are): the query client the feed polls through is
// 9.5 KB gzip in the entry. Master was 104.0 KB; this build is 113.6 KB.
// CSS raised on 2026-10-25 from 18.5 KB to 19 KB (the family sweep: Capsomer 0.11.2 to 0.21.0, as
// the family check requires): 0.18.0's roomier compact density and 0.17.0's label rules put the
// build 0.4 KB over; this build is 18.9 KB.
// 2026-10-26 (Dustin: move the Portal's own switches, command menu, shortcut sheet and confirm
// dialog onto Capsomer): initial JS raised from 115 KB to 119 KB, since Capsomer's shortcut
// registry, and the dialog code its sheet shares, now handle the keys from the entry. Master was
// 114.3 KB; this build is 118.2 KB. CSS is split: the dialogs' stylesheets (button, field, alert,
// details, switch, listbox) load with their chunks, so they are budgeted apart from the entry's.
// Initial CSS stays at 19 KB (this build 18.4 KB, master 18.9 KB); lazy CSS is 8.7 KB.
// Initial CSS raised on 2026-10-27 from 19 KB to 20.5 KB (Dustin: one shared letterhead across
// the family, the Portal's included): Capsomer 0.28.1's letterhead band, its second row of links
// and their underline are in the entry's site-header.css. Master was 18.8 KB; this build is 20.0 KB.
// Initial JS raised on 2026-10-28 from 119 KB to 121 KB (Capsomer 0.31.0): the admin shell's header
// now carries the search field's combobox. Master was 118.7 KB; this build is 120.0 KB.
// Initial CSS raised on 2026-10-28 from 20.5 KB to 21 KB (Capsomer 0.33: the admin letterhead keeps
// the public pages' pixels, Dustin): its inset padding and the ground above it. Master was 20,961 B;
// this build is 21,023 B.
// Initial CSS raised on 2026-10-28 from 21 KB to 22.5 KB: the Portal takes the explorer's teal family
// (Dustin: "match the theme of the site"), family-teal.css at 1.6 KB gzip. This build is 21.7 KB.
// Initial CSS raised on 2026-10-29 from 22.5 KB to 23 KB: Capsomer 0.37 to 0.41 grows the shared
// stylesheet. This build is 23,240 B.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const KB = 1024;
const BUDGET = { initialJs: 121 * KB, lazyChunk: 40 * KB, css: 23 * KB, lazyCss: 12 * KB };

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
// Their stylesheets are the initial CSS.
const initial = new Set();
const initialCss = new Set();
const walk = (key) => {
  const c = manifest[key];
  if (!c) fail(`the manifest has no chunk ${key}`);
  if (initial.has(c.file)) return;
  initial.add(c.file);
  for (const f of c.css ?? []) initialCss.add(f);
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

if (![...initialCss].some((f) => css.includes(f))) fail("no initial CSS found through the manifest");
let cssGz = 0;
let lazyCssGz = 0;
for (const f of css) {
  const s = sizeOf(f);
  const first = initialCss.has(f);
  if (first) cssGz += s.gz;
  else lazyCssGz += s.gz;
  rows.push([first ? "css" : "lazy css", f, s.raw, s.gz, ""]);
}
rows.push(["css", "TOTAL", null, cssGz, `<= ${fmt(BUDGET.css)}`]);
rows.push(["lazy css", "TOTAL", null, lazyCssGz, `<= ${fmt(BUDGET.lazyCss)}`]);
if (cssGz > BUDGET.css) problems.push(`initial CSS is ${fmt(cssGz)} gzip, over ${fmt(BUDGET.css)}`);
if (lazyCssGz > BUDGET.lazyCss) problems.push(`lazy CSS is ${fmt(lazyCssGz)} gzip, over ${fmt(BUDGET.lazyCss)}`);

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
