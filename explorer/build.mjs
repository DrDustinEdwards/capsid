// Builds the explorer into explorer/dist: every page prerendered, the assets beside them, and
// _headers. Run by .github/workflows/explorer.yml, which fetches the two public documents first.
//
//   npm run build -- [--model <file or url>] [--stats <file or url>] [--code <file or url>] [--out <dir>]
//
// The defaults are the live documents Capsid serves (src/public-data.ts); a model from a file
// builds no code pages unless --code names a code document too. Every document is checked with
// Capsid's own schemas before anything is written, so the explorer can only publish what the
// privacy filter's output shape allows (the third line, design section 2). The tests build from
// explorer/fixtures, which are invented.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { webManifest } from "@drdustinedwards/site-helpers/icons";
import { llmsDocument } from "@drdustinedwards/site-helpers/llms";
import { aiTxt, robotsDocument } from "@drdustinedwards/site-helpers/robots";
import { sitemapDocument } from "@drdustinedwards/site-helpers/sitemap";
import { securityTxt } from "@dustinedwards/site-runtime/security-txt";
import { writeIntegrity } from "@dustinedwards/site-runtime/sri";
import { buildSync } from "esbuild";

import { PublicCodeSchema } from "../src/public-code-schema.ts";
import { PublicStatsSchema } from "../src/public-stats.ts";
import { PublicModelSchema } from "../src/system-model.ts";
import { CIRCLES_URL, INDEXNOW_KEY, ORIGIN, allPages, circlesOf, searchDocument } from "./src/pages.mjs";

/** When security.txt lapses (RFC 9116 asks for under a year); renew it before then. */
const SECURITY_TXT_EXPIRES = "2027-10-25T00:00:00Z";
import { servedTools } from "./src/surface.mjs";

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
    // A bare specifier ("enarratio/base.css", which capsomer/enarratio.css imports) resolves as a bundler would.
    const inner = inlineCss(/^[./]/.test(rel) ? join(dirname(file), rel) : require.resolve(rel));
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

/** The site's llms.txt: what Capsid is and where each part of the explorer is. @param {number} systems @param {number} tools */
const llmsTxt = (systems, tools) =>
  llmsDocument({
    title: "Capsid",
    summary: "Capsid is an open-source (MIT) MCP server for AI coding agents, run on one Cloudflare Worker. Agents start every session from shared project notes, each one can use only the tools it is allowed, and when an agent says a job is done, Capsid checks GitHub. This site runs on one live Capsid server and rebuilds every day from its public data.",
    intro: ["- Code: https://github.com/DrDustinEdwards/capsid\n- Author: Dustin Edwards, https://dustinedwards.info"],
    sections: [
      {
        heading: "Pages",
        links: [
          { title: "Overview", url: `${ORIGIN}/`, description: "what Capsid is and how a job runs through it" },
          { title: "Systems", url: `${ORIGIN}/systems/`, description: `the ${systems} systems this instance runs, and what each is made of` },
          { title: "Flows", url: `${ORIGIN}/flows/`, description: "what runs through Capsid, step by step" },
          { title: "Tools", url: `${ORIGIN}/tools/`, description: `the ${tools} MCP tools Capsid serves and their arguments` },
          { title: "Numbers", url: `${ORIGIN}/numbers/`, description: "the instance's daily numbers" },
          { title: "Code", url: `${ORIGIN}/code/`, description: "each public repo's code, scored for risk" },
        ],
      },
    ],
  });

/** @param {{ model?: string, stats?: string, code?: string, out?: string }} [options] */
export async function build({ model: modelSource = `${LIVE}/model/v1.json`, stats: statsSource = `${LIVE}/stats/v1.json`, code: codeSource = modelSource === `${LIVE}/model/v1.json` ? `${LIVE}/code/v1.json` : undefined, out = join(here, "dist") } = {}) {
  const model = PublicModelSchema.parse(await read(modelSource));
  const stats = PublicStatsSchema.parse(await read(statsSource));
  const code = await readCode(codeSource);

  rmSync(out, { recursive: true, force: true });
  const tools = servedTools();
  const pages = allPages(model, stats, code, tools);
  for (const [path, html] of pages) {
    const file = path === "/404" ? join(out, "404.html") : join(out, decodeURIComponent(path), "index.html");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
  }

  const assets = join(out, "assets");
  mkdirSync(assets, { recursive: true });
  const capsomer = dirname(require.resolve("capsomer/package.json"));
  const css = [
    "css/fonts.css",
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
    "components/manual/manual.css",
    "components/family-footer/family-footer.css",
    "components/chart-frame/chart-frame.css",
    "components/meter/meter.css",
    "tokens/site-capsid.css",
  ]
    .map((rel) => inlineCss(join(capsomer, rel)))
    .join("\n");
  writeFileSync(join(assets, "capsomer.css"), css);
  // The whole chart stylesheet, as every site loads it: Enarratio's base rules on Capsomer's tokens, gridlines, series inks
  // and color pairs (capsomer/enarratio.css; the teal family and prefers-contrast come from the tokens).
  writeFileSync(join(assets, "enarratio.css"), inlineCss(join(capsomer, "css", "enarratio.css")));
  copyFileSync(join(here, "src", "explorer.css"), join(assets, "explorer.css"));
  writeFileSync(join(out, CIRCLES_URL), JSON.stringify(circlesOf(model)));
  // The page's one module, bundled: src/explorer.js imports tabs, Capsomer's chart-enhance and the
  // system map's and the header's modules by the paths they are staged at here, each folder whole
  // (its React wrapper aside), because they import their siblings by "./" and each other by
  // "../name/" (the map takes email's escapeHtml). The map's circles are drawn here, not in the
  // browser. One file, so the script tag's integrity covers all of it: sixteen modulepreloads
  // carrying the imports' integrity cost the home page 0.7 s of Lighthouse LCP.
  const stage = join(out, ".bundle");
  mkdirSync(stage, { recursive: true });
  copyFileSync(join(capsomer, "dist", "components", "tabs", "tabs.js"), join(stage, "tabs.js"));
  for (const name of ["system-map", "email", "site-header", "theme-switch", "dialog", "popover", "tooltip", "shell", "meter"]) {
    const dir = join(capsomer, "dist", "components", name);
    mkdirSync(join(stage, "capsomer", name), { recursive: true });
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".js") && !f.endsWith(".react.js") && !f.startsWith("system-map-circles"))) copyFileSync(join(dir, file), join(stage, "capsomer", name, file));
  }
  copyFileSync(join(here, "src", "explorer.js"), join(stage, "explorer.js"));
  buildSync({ entryPoints: [join(stage, "explorer.js")], outfile: join(assets, "explorer.js"), bundle: true, nodePaths: [join(here, "node_modules")], format: "esm", minify: true, logLevel: "warning" });
  rmSync(stage, { recursive: true });
  copyFileSync(join(here, "src", "theme.js"), join(assets, "theme.js"));
  writeFileSync(join(assets, "search.json"), JSON.stringify(searchDocument(model, code, tools)));
  // The family icon set (Prelum's prelum-icons) at the root, where iconLinks() and the manifest point.
  cpSync(join(here, "src", "icons"), out, { recursive: true });
  writeFileSync(join(out, "site.webmanifest"), JSON.stringify(webManifest({ name: "Capsid", themeColor: "#01585c", backgroundColor: "#01585c", lang: "en" })));
  copyFileSync(join(here, "src", "og-card.png"), join(assets, "og-card.png"));
  // The family's faces (capsomer/fonts.css, inlined above), served from here because the policy
  // allows fonts from 'self' only: Capsomer's fonts/ beside assets/, where its "../fonts/" points.
  cpSync(join(capsomer, "fonts"), join(out, "fonts"), { recursive: true });
  // _headers from the explorer's entry in site-runtime's registry (capsid), by its one bin: the shared set, the page
  // policy reporting to Capsid's /csp-report, and Prelum's training reservation (the TDMRep header ai.txt names).
  const headersBin = join(dirname(fileURLToPath(import.meta.resolve("@dustinedwards/site-runtime/sites"))), "bin", "site-runtime-headers.mjs");
  execFileSync(process.execPath, [headersBin, "--site", "capsid", "--out", join(out, "_headers"), "--header", "tdm-reservation: 1"]);
  // For search engines and language models, from Prelum: every page in a sitemap, robots.txt (the
  // family bot policy; Cloudflare puts its own lines first), ai.txt (citation welcome, training
  // reserved, as the tdm-reservation header in _headers says) and llms.txt (https://llmstxt.org),
  // a short guide.
  const listed = pages.map(([path]) => path).filter((path) => path !== "/404" && path !== "/search/");
  writeFileSync(join(out, "sitemap.xml"), sitemapDocument(listed.map((path) => ({ loc: ORIGIN + path }))));
  writeFileSync(join(out, "robots.txt"), robotsDocument({ origin: ORIGIN, notes: [`AI usage policy: ${ORIGIN}/ai.txt`, `LLM guide: ${ORIGIN}/llms.txt`] }));
  writeFileSync(join(out, "ai.txt"), aiTxt({ origin: ORIGIN, name: "Capsid", contact: "contact@dustinedwards.info" }));
  writeFileSync(join(out, "llms.txt"), llmsTxt(model.systems.length, tools.length));
  // The family's security contact (RFC 9116) and the IndexNow key file the deploy pings with.
  mkdirSync(join(out, ".well-known"), { recursive: true });
  writeFileSync(join(out, ".well-known", "security.txt"), securityTxt({ origin: ORIGIN, contact: "security@dustinedwards.info", expires: SECURITY_TXT_EXPIRES }));
  writeFileSync(join(out, `${INDEXNOW_KEY}.txt`), INDEXNOW_KEY);
  // What this build is of, and a hash of everything else it wrote: the workflow deploys only
  // when the hash differs from the live build.json (ruling answer 8), whether the data or the
  // explorer's own files changed. Written last, so the hash cannot cover itself.
  // A sha384 integrity and crossorigin on every page's two script tags, for Integrity-Policy (site-runtime ./sri).
  await writeIntegrity(out);
  const content = contentHash(out);
  writeFileSync(join(out, "build.json"), `${JSON.stringify({ model_as_of: model.as_of, stats_as_of: stats.as_of, code_as_of: code?.as_of ?? null, systems: model.systems.length, content }, null, 2)}\n`);
  return { pages: pages.length, out, content };
}

if (process.argv[1] === import.meta.filename) {
  const { values } = parseArgs({ options: { model: { type: "string" }, stats: { type: "string" }, code: { type: "string" }, out: { type: "string" } } });
  const result = await build(/** @type {any} */ (values));
  console.log(`explorer: built ${result.pages} pages into ${result.out}`);
}
