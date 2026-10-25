// Builds the explorer into explorer/dist: every page prerendered, the assets beside them, and
// _headers. Run by .github/workflows/explorer.yml, which fetches the two public documents first.
//
//   npm run build -- [--model <file or url>] [--stats <file or url>] [--code <file or url>] [--source <dir>] [--out <dir>]
//
// The defaults are the live documents Capsid serves (src/public-data.ts); a model from a file
// builds no code pages unless --code names a code document too. Each code map's
// source is read from GitHub at the commit the map measured, or from <dir>/<owner>/<repo>/<path>
// with --source. Every document is checked with
// Capsid's own schemas before anything is written, so the explorer can only publish what the
// privacy filter's output shape allows (the third line, design section 2). The tests build from
// explorer/fixtures, which are invented.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";

import { stylesheet } from "enarratio";
import { capsomerTheme } from "capsomer/enarratio-theme";

import { PublicCodeSchema } from "../src/public-code-schema.ts";
import { PublicStatsSchema } from "../src/public-stats.ts";
import { PublicModelSchema } from "../src/system-model.ts";
import { headersFile } from "./src/security-headers.mjs";
import { codeBySystem, escapePath } from "./src/code.mjs";
import { CIRCLES_URL, ORIGIN, allPages, circlesOf, escapeHtml, searchDocument } from "./src/pages.mjs";
import { servedTools } from "./src/surface.mjs";

const here = import.meta.dirname;
const require = createRequire(import.meta.url);
const LIVE = "https://mcp.dustinedwards.info/public";
const GENERATED = /\.generated\.[^/]+$/;

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

/**
 * The code document, or null while Capsid has not built one yet: its route answers 503 until the
 * first daily build after the route shipped, and the rest of the explorer does not wait for it.
 * @param {string | undefined} source
 */
async function readCode(source) {
  if (!source) return null;
  if (/^https:\/\//.test(source)) {
    const response = await fetch(source, { headers: { accept: "application/json" } });
    if (response.status === 503) {
      console.log(`explorer: ${source} is not computed yet, so no code pages`);
      return null;
    }
    if (!response.ok) throw new Error(`GET ${source} answered ${response.status}`);
    return PublicCodeSchema.parse(await response.json());
  }
  return PublicCodeSchema.parse(JSON.parse(readFileSync(source, "utf8")));
}

/**
 * Every module's source, keyed "owner/repo path": from a directory, or from GitHub at the
 * map's commit, a few files at a time. A file GitHub does not have stops the build, since the
 * map says it was there at that commit, except a build-time generated one (name.generated.ext):
 * a repo's code map runs after its install writes them, but git never holds them, so their
 * pages show no source.
 * @param {any} code @param {string | undefined} dir
 */
async function readSources(code, dir) {
  /** @type {Map<string, string>} */
  const out = new Map();
  const wanted = (code?.maps ?? []).flatMap((/** @type {any} */ map) => map.modules.map((/** @type {any} */ m) => ({ repo: map.repo, sha: map.sha, path: m.path })));
  if (dir) {
    for (const w of wanted) {
      const file = join(dir, w.repo, w.path);
      if (existsSync(file)) out.set(`${w.repo} ${w.path}`, readFileSync(file, "utf8"));
    }
    return out;
  }
  for (let i = 0; i < wanted.length; i += 8) {
    await Promise.all(
      wanted.slice(i, i + 8).map(async (/** @type {{ repo: string, sha: string, path: string }} */ w) => {
        const url = `https://raw.githubusercontent.com/${w.repo}/${w.sha}/${escapePath(w.path)}`;
        const response = await fetch(url);
        if (response.status === 404 && GENERATED.test(w.path)) return;
        if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
        out.set(`${w.repo} ${w.path}`, await response.text());
      })
    );
  }
  return out;
}

/** The site's llms.txt: what Capsid is and where each part of the explorer is. @param {number} systems @param {number} tools */
const llmsTxt = (systems, tools) => `# Capsid

> Capsid is an open-source (MIT) MCP server and control plane for AI coding agents, on one Cloudflare Worker: a signed work queue, scoped grants checked at one point, and every agent's claim checked against GitHub before a job counts as done. This site is one live instance, seen from outside, rebuilt every day from its public data.

- Code: https://github.com/DrDustinEdwards/capsid
- Author: Dustin Edwards, https://dustinedwards.info

## Pages

- [Overview](${ORIGIN}/): what Capsid is and how a job runs through it
- [Systems](${ORIGIN}/systems/): the ${systems} systems this instance runs, and what each is made of
- [Flows](${ORIGIN}/flows/): what runs through Capsid, step by step
- [Tools](${ORIGIN}/tools/): the ${tools} MCP tools Capsid serves and their arguments
- [Numbers](${ORIGIN}/numbers/): the instance's daily numbers
- [Code](${ORIGIN}/code/): each system's code and its health
`;

/** @param {{ model?: string, stats?: string, code?: string, source?: string, out?: string }} [options] */
export async function build({ model: modelSource = `${LIVE}/model/v1.json`, stats: statsSource = `${LIVE}/stats/v1.json`, code: codeSource = modelSource === `${LIVE}/model/v1.json` ? `${LIVE}/code/v1.json` : undefined, source: sourceDir, out = join(here, "dist") } = {}) {
  const model = PublicModelSchema.parse(await read(modelSource));
  const stats = PublicStatsSchema.parse(await read(statsSource));
  const code = await readCode(codeSource);
  // Checked against the model before any source is read, so no private system's file is fetched.
  codeBySystem(model, code);
  const sources = await readSources(code, sourceDir);

  rmSync(out, { recursive: true, force: true });
  const tools = servedTools();
  const pages = allPages(model, stats, code, (repo, path) => sources.get(`${repo} ${path}`), tools);
  for (const [path, html] of pages) {
    const file = path === "/404" ? join(out, "404.html") : join(out, decodeURIComponent(path), "index.html");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
  }

  const assets = join(out, "assets");
  mkdirSync(assets, { recursive: true });
  const capsomer = dirname(require.resolve("capsomer/package.json"));
  const css = [
    "css/tokens.css",
    "tokens/family-teal.css",
    "css/base.css",
    "components/button/button.css",
    "components/table/table.css",
    "components/status/status.css",
    "components/system-map/system-map.css",
    "components/tabs/tabs.css",
    "components/field/field.css",
    "components/popover/popover.css",
    "components/tooltip/tooltip.css",
    "components/dialog/dialog.css",
    "components/theme-switch/theme-switch.css",
    "components/site-header/site-header.css",
    "tokens/site-capsid.css",
    
  ]
    .map((rel) => inlineCss(join(capsomer, rel)))
    .join("\n");
  writeFileSync(join(assets, "capsomer.css"), css);
  writeFileSync(join(assets, "enarratio.css"), stylesheet(capsomerTheme));
  copyFileSync(join(here, "src", "explorer.css"), join(assets, "explorer.css"));
  // The system map's module and the sibling modules it imports; its circles are drawn here, not in the browser.
  const systemMap = join(capsomer, "dist", "components", "system-map");
  for (const file of readdirSync(systemMap).filter((name) => name.endsWith(".js") && !name.startsWith("system-map-circles"))) copyFileSync(join(systemMap, file), join(assets, file));
  writeFileSync(join(out, CIRCLES_URL), JSON.stringify(circlesOf(model)));
  copyFileSync(join(capsomer, "dist", "components", "tabs", "tabs.js"), join(assets, "tabs.js"));
  // The header's modules keep their folders, because they import each other by "../name/".
  for (const name of ["site-header", "theme-switch", "dialog", "popover", "tooltip", "shell"]) {
    mkdirSync(join(assets, "capsomer", name), { recursive: true });
    copyFileSync(join(capsomer, "dist", "components", name, `${name}.js`), join(assets, "capsomer", name, `${name}.js`));
  }
  copyFileSync(join(here, "src", "theme.js"), join(assets, "theme.js"));
  copyFileSync(require.resolve("enarratio/enhance"), join(assets, "enhance.js"));
  copyFileSync(join(here, "src", "explorer.js"), join(assets, "explorer.js"));
  writeFileSync(join(assets, "search.json"), JSON.stringify(searchDocument(model, code, tools)));
  copyFileSync(join(here, "src", "icon.svg"), join(assets, "icon.svg"));
  // Capsomer's face, served from here because the policy allows fonts from 'self' only: Schibsted
  // Grotesk's latin cut with its weight axis.
  copyFileSync(join(dirname(require.resolve("@fontsource-variable/schibsted-grotesk/package.json")), "files", "schibsted-grotesk-latin-wght-normal.woff2"), join(assets, "schibsted.woff2"));
  writeFileSync(join(out, "_headers"), headersFile());
  // For search engines and language models: every page in a sitemap, robots.txt pointing to it,
  // and llms.txt (https://llmstxt.org), a short guide. Cloudflare puts its own robots.txt lines first.
  const listed = pages.map(([path]) => path).filter((path) => path !== "/404" && path !== "/search/");
  writeFileSync(join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${listed.map((path) => `<url><loc>${escapeHtml(ORIGIN + path)}</loc></url>`).join("\n")}\n</urlset>\n`);
  writeFileSync(join(out, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n# LLM guide: ${ORIGIN}/llms.txt\n`);
  writeFileSync(join(out, "llms.txt"), llmsTxt(model.systems.length, tools.length));
  // What this build is of, and a hash of everything else it wrote: the workflow deploys only
  // when the hash differs from the live build.json (ruling answer 8), whether the data or the
  // explorer's own files changed. Written last, so the hash cannot cover itself.
  const content = contentHash(out);
  writeFileSync(join(out, "build.json"), `${JSON.stringify({ model_as_of: model.as_of, stats_as_of: stats.as_of, code_as_of: code?.as_of ?? null, systems: model.systems.length, content }, null, 2)}\n`);
  return { pages: pages.length, out, content };
}

if (process.argv[1] === import.meta.filename) {
  const { values } = parseArgs({ options: { model: { type: "string" }, stats: { type: "string" }, code: { type: "string" }, source: { type: "string" }, out: { type: "string" } } });
  const result = await build(/** @type {any} */ (values));
  console.log(`explorer: built ${result.pages} pages into ${result.out}`);
}
