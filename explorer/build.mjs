// Builds the explorer into explorer/dist: every page prerendered, the assets beside them, and
// _headers. Run by .github/workflows/explorer.yml, which fetches the two public documents first.
//
//   npm run build -- [--model <file or url>] [--stats <file or url>] [--out <dir>]
//
// The defaults are the live documents Capsid serves (src/public-data.ts). Both are checked with
// Capsid's own schemas before anything is written, so the explorer can only publish what the
// privacy filter's output shape allows (the third line, design section 2). The tests build from
// explorer/fixtures, which are invented.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";

import { stylesheet } from "enarratio";
import { capsomerTheme } from "capsomer/enarratio-theme";

import { PublicStatsSchema } from "../src/public-stats.ts";
import { PublicModelSchema } from "../src/system-model.ts";
import { headersFile } from "./src/headers.mjs";
import { allPages } from "./src/pages.mjs";

const here = import.meta.dirname;
const require = createRequire(import.meta.url);
const LIVE = "https://mcp.dustinedwards.info/public";

/** @param {string} source a path or an https URL */
async function read(source) {
  if (/^https:\/\//.test(source)) {
    const response = await fetch(source, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`GET ${source} answered ${response.status}`);
    return response.json();
  }
  return JSON.parse(readFileSync(source, "utf8"));
}

/** One hash over every file under a directory, its path and its bytes, in a fixed order. */
function contentHash(/** @type {string} */ dir) {
  const hash = createHash("sha256");
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
  for (const file of files) hash.update(`${file}\0`).update(readFileSync(join(dir, file))).update("\0");
  return hash.digest("hex");
}

/**
 * Capsomer's CSS as one file: each import inlined, a layered one inside its layer.
 * @param {string} file
 * @returns {string}
 */
function inlineCss(file) {
  const text = readFileSync(file, "utf8");
  return text.replace(/@import\s+"([^"]+)"(?:\s+layer\(([^)]+)\))?\s*;/g, (_m, /** @type {string} */ rel, /** @type {string | undefined} */ layer) => {
    const inner = inlineCss(join(dirname(file), rel));
    return layer ? `@layer ${layer} {\n${inner}\n}` : inner;
  });
}

export async function build({ model: modelSource = `${LIVE}/model/v1.json`, stats: statsSource = `${LIVE}/stats/v1.json`, out = join(here, "dist") } = {}) {
  const model = PublicModelSchema.parse(await read(modelSource));
  const stats = PublicStatsSchema.parse(await read(statsSource));

  rmSync(out, { recursive: true, force: true });
  const pages = allPages(model, stats);
  for (const [path, html] of pages) {
    const file = path === "/404" ? join(out, "404.html") : join(out, path, "index.html");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
  }

  const assets = join(out, "assets");
  mkdirSync(assets, { recursive: true });
  const capsomer = dirname(require.resolve("capsomer/package.json"));
  const css = [
    "css/tokens.css",
    "css/base.css",
    "components/button/button.css",
    "components/table/table.css",
    "components/system-map/system-map.css",
  ]
    .map((rel) => inlineCss(join(capsomer, rel)))
    .join("\n");
  writeFileSync(join(assets, "capsomer.css"), css);
  writeFileSync(join(assets, "enarratio.css"), stylesheet(capsomerTheme));
  copyFileSync(join(here, "src", "explorer.css"), join(assets, "explorer.css"));
  copyFileSync(join(capsomer, "dist", "components", "system-map", "system-map.js"), join(assets, "system-map.js"));
  copyFileSync(join(here, "src", "explorer.js"), join(assets, "explorer.js"));
  copyFileSync(join(here, "src", "icon.svg"), join(assets, "icon.svg"));
  writeFileSync(join(out, "_headers"), headersFile());
  // What this build is of, and a hash of everything else it wrote: the workflow deploys only
  // when the hash differs from the live build.json (ruling answer 8), whether the data or the
  // explorer's own files changed. Written last, so the hash cannot cover itself.
  const content = contentHash(out);
  writeFileSync(join(out, "build.json"), `${JSON.stringify({ model_as_of: model.as_of, stats_as_of: stats.as_of, systems: model.systems.length, content }, null, 2)}\n`);
  return { pages: pages.length, out, content };
}

if (process.argv[1] === import.meta.filename) {
  const { values } = parseArgs({ options: { model: { type: "string" }, stats: { type: "string" }, out: { type: "string" } } });
  const result = await build(/** @type {any} */ (values));
  console.log(`explorer: built ${result.pages} pages into ${result.out}`);
}
