// Run by explorer.yml, which fetches the two public documents first. Every document is checked with Capsid's own
// schemas before anything is written, so only what the privacy filter's output shape allows is published (design section 2).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { webManifest } from "@drdustinedwards/site-helpers/icons";
import { llmsDocument } from "@drdustinedwards/site-helpers/llms";
import {
  writeMarkdownCopies,
  writeSitemapLastmod,
} from "@drdustinedwards/site-helpers/markdown-files";
import { aiTxt, robotsDocument } from "@drdustinedwards/site-helpers/robots";
import { sitemapDocument } from "@drdustinedwards/site-helpers/sitemap";
import { securityTxt } from "@dustinedwards/site-runtime/security-txt";
import { writeIntegrity } from "@dustinedwards/site-runtime/sri";
import { parsePublicModel } from "capsomer/behavior/system-model";
import { themeScript } from "capsomer/theme-server";
import {
  CAPSOMER_ROOT,
  bundleScript,
  capsomerStylesheet,
  copyFonts,
  inlineCss,
  minifyCss,
} from "capsomer/build";
import { buildSync } from "esbuild";

import { PublicCodeSchema } from "../src/public-code-schema.ts";
import { PublicStatsSchema } from "../src/public-stats.ts";
import { INDEXNOW_KEY, ORIGIN, allPages, searchDocument } from "./src/pages.mjs";

const SECURITY_TXT_EXPIRES = "2027-10-25T00:00:00Z";
import { servedTools } from "./src/surface.mjs";

const here = import.meta.dirname;
// The Worker imports site-runtime and Prelum, which the repo root installs, so the hash's bundle names both places.
const nodePaths = [join(here, "node_modules"), join(here, "..", "node_modules")];
const LIVE = "https://mcp.dustinedwards.info/public";

/** @param {string} source */
async function read(source) {
  if (source.startsWith("https://")) {
    const response = await fetch(source, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`GET ${source} answered ${response.status}`);
    return response.json();
  }
  return JSON.parse(readFileSync(source, "utf8"));
}

// One hash over every file under a directory and the Worker as it deploys, so a dependency bump that
// changes only the Worker still differs from the live build.
function contentHash(/** @type {string} */ dir) {
  const hash = createHash("sha256");
  const worker = buildSync({
    entryPoints: [join(here, "worker.mjs")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    nodePaths: nodePaths,
    logLevel: "warning",
  });
  hash.update("worker.mjs\0").update(worker.outputFiles[0].contents).update("\0");
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
  for (const file of files)
    hash
      .update(`${file}\0`)
      .update(readFileSync(join(dir, file)))
      .update("\0");
  return hash.digest("hex");
}

// Null while Capsid has not built one: its route answers 503 until the first daily build after the route shipped.
/** @param {string | undefined} source */
async function readCode(source) {
  if (!source) return null;
  if (source.startsWith("https://")) {
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

/** @param {number} systems @param {number} tools */
const llmsTxt = (systems, tools) =>
  llmsDocument({
    title: "Capsid",
    summary:
      "Capsid is an open-source (MIT) MCP server for AI coding agents, run on one Cloudflare Worker. Agents start every session from shared project notes, each one can use only the tools it is allowed, and when an agent says a job is done, Capsid checks GitHub. This site runs on one live Capsid server and rebuilds every day from its public data.",
    intro: [
      "- Code: https://github.com/DrDustinEdwards/capsid\n- Author: Dustin Edwards, https://dustinedwards.info",
    ],
    sections: [
      {
        heading: "Pages",
        links: [
          {
            title: "Overview",
            url: `${ORIGIN}/`,
            description: "what Capsid is and how a job runs through it",
          },
          {
            title: "Systems",
            url: `${ORIGIN}/systems/`,
            description: `the ${systems} systems this instance runs, and what each is made of`,
          },
          {
            title: "Flows",
            url: `${ORIGIN}/flows/`,
            description: "what runs through Capsid, step by step",
          },
          {
            title: "Tools",
            url: `${ORIGIN}/tools/`,
            description: `the ${tools} MCP tools Capsid serves and their arguments`,
          },
          {
            title: "Numbers",
            url: `${ORIGIN}/numbers/`,
            description: "the instance's daily numbers",
          },
          {
            title: "Code",
            url: `${ORIGIN}/code/`,
            description: "each public repo's code, scored for risk",
          },
        ],
      },
    ],
  });

/** @param {{ model?: string, stats?: string, code?: string, out?: string, previous?: string, today?: string }} [options] */
export async function build({
  model: modelSource = `${LIVE}/model/v1.json`,
  stats: statsSource = `${LIVE}/stats/v1.json`,
  code: codeSource = modelSource === `${LIVE}/model/v1.json` ? `${LIVE}/code/v1.json` : undefined,
  out = join(here, "dist"),
  previous: previousSource = modelSource === `${LIVE}/model/v1.json`
    ? `${ORIGIN}/build.json`
    : undefined,
  today = new Date().toISOString().slice(0, 10),
} = {}) {
  const parsed = parsePublicModel(await read(modelSource));
  if (!parsed.ok)
    throw new Error(`${modelSource} is not a public model: ${parsed.problems.join("; ")}`);
  const model = parsed.model;
  const stats = PublicStatsSchema.parse(await read(statsSource));
  const code = await readCode(codeSource);

  rmSync(out, { recursive: true, force: true });
  const tools = servedTools();
  const pages = allPages(model, stats, code, tools);
  for (const [path, html] of pages) {
    const file =
      path === "/404" ? join(out, "404.html") : join(out, decodeURIComponent(path), "index.html");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
  }

  const assets = join(out, "assets");
  mkdirSync(assets, { recursive: true });
  const css = capsomerStylesheet({
    family: "teal",
    site: "capsid",
    fontsUrl: "../fonts/",
    parts: [
      "button",
      "table",
      "status",
      "system-map",
      "tabs",
      "field",
      "popover",
      "tooltip",
      "dialog",
      "theme-switch",
      "site-header",
      "manual",
      "family-footer",
      "hero",
      "chart-frame",
      "meter",
      "graph",
    ],
  });
  // Every stylesheet blocks first paint, so each ships minified: on slow 4G the comment-heavy Capsomer sources held the
  // home page's LCP within 50 ms of its 2.5 s budget.
  writeFileSync(join(assets, "capsomer.css"), await minifyCss(css));
  writeFileSync(
    join(assets, "enarratio.css"),
    await minifyCss(inlineCss(join(CAPSOMER_ROOT, "css", "enarratio.css"))),
  );
  writeFileSync(
    join(assets, "explorer.css"),
    await minifyCss(readFileSync(join(here, "src", "explorer.css"), "utf8")),
  );
  // One file, so the script tag's integrity covers all of it: sixteen modulepreloads carrying the imports'
  // integrity cost the home page 0.7 s of Lighthouse LCP.
  writeFileSync(join(assets, "explorer.js"), await bundleScript(join(here, "src", "explorer.js")));
  // Set before first paint so the page never flashes the other theme. A file, not an inline script, so the policy
  // needs no hash; it also marks the page scripted so the panel's breakers are laid out from the start.
  writeFileSync(
    join(assets, "theme.js"),
    `document.documentElement.classList.add("js");\n${themeScript()}\n`,
  );
  writeFileSync(join(assets, "search.json"), JSON.stringify(searchDocument(model, code, tools)));
  cpSync(join(here, "src", "icons"), out, { recursive: true });
  writeFileSync(
    join(out, "site.webmanifest"),
    JSON.stringify(
      webManifest({
        name: "Capsid",
        themeColor: "#01585c",
        backgroundColor: "#01585c",
        lang: "en",
      }),
    ),
  );
  copyFileSync(join(here, "src", "og-card.png"), join(assets, "og-card.png"));
  // Served from here because the policy allows fonts from 'self' only.
  copyFonts(join(out, "fonts"));
  const headersBin = join(
    dirname(fileURLToPath(import.meta.resolve("@dustinedwards/site-runtime/sites"))),
    "bin",
    "site-runtime-headers.mjs",
  );
  execFileSync(process.execPath, [
    headersBin,
    "--site",
    "capsid",
    "--out",
    join(out, "_headers"),
    "--header",
    "tdm-reservation: 1",
  ]);
  const listed = pages
    .map(([path]) => path)
    .filter((path) => path !== "/404" && path !== "/search/");
  writeFileSync(
    join(out, "sitemap.xml"),
    sitemapDocument(listed.map((path) => ({ loc: ORIGIN + path }))),
  );
  writeFileSync(
    join(out, "robots.txt"),
    robotsDocument({
      origin: ORIGIN,
      notes: [`AI usage policy: ${ORIGIN}/ai.txt`, `LLM guide: ${ORIGIN}/llms.txt`],
    }),
  );
  writeFileSync(
    join(out, "ai.txt"),
    aiTxt({ origin: ORIGIN, name: "Capsid", contact: "contact@dustinedwards.info" }),
  );
  writeFileSync(join(out, "llms.txt"), llmsTxt(model.systems.length, tools.length));
  mkdirSync(join(out, ".well-known"), { recursive: true });
  writeFileSync(
    join(out, ".well-known", "security.txt"),
    securityTxt({
      origin: ORIGIN,
      contact: "security@dustinedwards.info",
      expires: SECURITY_TXT_EXPIRES,
    }),
  );
  writeFileSync(join(out, `${INDEXNOW_KEY}.txt`), INDEXNOW_KEY);
  // The search page is not in the sitemap, so it gets no Markdown copy.
  await writeMarkdownCopies({ dir: out, origin: ORIGIN, skip: (path) => path === "/search" });
  // With no record to compare (a local-fixtures build) no URL has a lastmod, since none is better than a wrong one.
  const dates = previousSource
    ? await writeSitemapLastmod({ dir: out, origin: ORIGIN, previous: previousSource, today })
    : {};
  // The workflow deploys only when the hash differs from the live build.json (ruling answer 8). Written last, so the hash cannot cover itself.
  await writeIntegrity(out);
  const content = contentHash(out);
  writeFileSync(
    join(out, "build.json"),
    `${JSON.stringify({ model_as_of: model.as_of, stats_as_of: stats.as_of, code_as_of: code?.as_of ?? null, systems: model.systems.length, content, pages: dates }, null, 2)}\n`,
  );
  return { pages: pages.length, out, content };
}

if (process.argv[1] === import.meta.filename) {
  const { values } = parseArgs({
    options: {
      model: { type: "string" },
      stats: { type: "string" },
      code: { type: "string" },
      out: { type: "string" },
      previous: { type: "string" },
      today: { type: "string" },
    },
  });
  const result = await build(/** @type {any} */ (values));
  console.log(`explorer: built ${result.pages} pages into ${result.out}`);
}
