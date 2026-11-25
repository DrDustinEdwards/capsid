// Pure: no file, network or clock; build.mjs writes what these return. A private system has a page that says so, so no
// link 404s. Times of day never appear: the documents carry a date and nothing finer.
import { modelMapData, systemMapHtml, tiesOf } from "capsomer/behavior/system-map";
import { patchSvg } from "capsomer/behavior/manual";
import { familyFooterHtml } from "capsomer/behavior/family-footer";
import { letterheadHtml } from "capsomer/behavior/site-header";
import { escapeHtml } from "@dustinedwards/site-runtime/html";
import { defineHead, headHtml } from "@drdustinedwards/site-helpers/head";
import { sectionOf } from "@drdustinedwards/site-helpers/site-map";
import { iconLinks } from "@drdustinedwards/site-helpers/icons";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";
import { accessibilityStatement } from "@drdustinedwards/site-helpers/accessibility";

import {
  codeBySystem,
  codeHome,
  codeIndexPage,
  codePages,
  codePath,
  codeSummary,
  codeTotals,
  riskiest,
} from "./code.mjs";
import { homePage } from "./home.mjs";
import { numbersPage } from "./numbers.mjs";
import { searchIndex, searchPage } from "./search.mjs";
import { toolPages } from "./tools.mjs";

export const SITE = "https://dustinedwards.info";
export const ORIGIN = "https://capsid.dustinedwards.info";
// Public by design: served as /<key>.txt (build.mjs).
export const INDEXNOW_KEY = "a2cbc5ceca2a712d80485582eb13b926";

const RING_NAMES = { core: "Runs everything", shared: "Shared parts", used: "What people use" };
const VERB = {
  installs: ["installs", "is installed by"],
  "publishes-to": ["publishes to", "is published to by"],
  coordinates: ["coordinates", "is coordinated by"],
  watches: ["watches", "is watched by"],
  reads: ["reads", "is read by"],
  writes: ["writes to", "is written to by"],
  deploys: ["deploys", "is deployed by"],
  serves: ["serves", "is served by"],
};

/** @param {string} id */
export const systemPath = (id) => `/s/${id}/`;
/** @param {string} id */
export const containersPath = (id) => `/s/${id}/containers/`;
/** @param {string} id */
export const sitePath = (id) => `${SITE}/systems/${id}`;
/** @param {string} id */
export const flowPath = (id) => `/flows/${id}/`;
/** @param {string} id @param {number} n */
export const stepPath = (id, n) => `/flows/${id}/${n}/`;
/** @param {{ id: string, system: string }} c */
export const partPath = (c) => `${containersPath(c.system)}#part-${c.id}`;

export const NAV = [
  ["/", "Overview"],
  ["/systems/", "Systems"],
  ["/flows/", "Flows"],
  ["/tools/", "Tools"],
  ["/numbers/", "Numbers"],
  ["/code/", "Code"],
];

const NAMES = Object.fromEntries(NAV);
const LISTS = ["/systems/", "/flows/", "/tools/", "/code/"];

// The last, with no root, is none.
const NAV_SECTIONS = [
  ...NAV.map(([href, heading]) => ({
    id: href,
    heading,
    to: href,
    roots: href === "/" ? ["/"] : href === "/systems/" ? ["/systems", "/s"] : [href.slice(0, -1)],
  })),
  { id: "", heading: "", to: null, roots: [] },
];

// A system's code page is under Code.
/** @param {string} path */
const navSection = (path) =>
  /^\/s\/[^/]+\/code\//.test(path) ? "/code/" : sectionOf(path, NAV_SECTIONS);

export const CARD = {
  url: "/assets/og-card.png",
  width: 1200,
  height: 630,
  alt: "A travel poster: Visit Capsid. AI agents say it's done. Capsid checks.",
};
const head = defineHead({
  origin: ORIGIN,
  siteName: "Capsid",
  image: CARD,
  suffix: ", Capsid",
  locale: "en_US",
});

const ICON_LINKS = iconLinks()
  .map(
    (link) =>
      `<link ${Object.entries(link)
        .map(([name, value]) => `${name}="${value}"`)
        .join(" ")}>`,
  )
  .join("\n");

// No inline script or style, so the policy in _headers needs no hash (JSON-LD is data, not script). The 404 says
// noindex and claims no canonical; `noindex` keeps the search page out of search, its results being already listed.
/** @param {{ title: string, description: string, path: string, body: string, asOf: string, wide?: boolean, data?: Record<string, unknown>[], fullTitle?: boolean, parent?: [string, string], noindex?: boolean }} page */
export function layout({
  title,
  description,
  path,
  body,
  asOf,
  wide = false,
  data = [],
  fullTitle,
  parent,
  noindex = false,
}) {
  const here = navSection(path);
  const missing = path === "/404";
  // Every page is served at its slash, so the canonical and the trail keep it (Prelum's own trail drops it).
  const section = here && here !== "/" && here !== path ? [[here, NAMES[here]]] : [];
  const trail = [["/", NAMES["/"]], ...section, ...(parent ? [parent] : []), [path, title]].map(
    ([href, name]) => ({ name, path: href }),
  );
  const pageType = LISTS.includes(path) ? "CollectionPage" : undefined;
  const tags = head({
    path,
    title,
    fullTitle,
    description,
    noindex: missing || noindex,
    keepTrailingSlash: true,
    breadcrumbs: path === "/" ? false : trail,
    pageType,
  });
  const headMarkup = headHtml([
    ...tags.filter((tag) => !(missing && "tagName" in tag && tag.rel === "canonical")),
    ...data.map(jsonLd),
  ]);
  return `<!doctype html>
<html lang="en" data-cap-site="capsid" data-family="teal">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="text-scale" content="scale">
${headMarkup}
${ICON_LINKS}
<link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/capsomer.css">
${body.includes('class="enarratio') ? '<link rel="stylesheet" href="/assets/enarratio.css">\n' : ""}<link rel="stylesheet" href="/assets/explorer.css">
<script src="/assets/theme.js"></script>
<script type="module" src="/assets/explorer.js"></script>
</head>
<body>
${header(here, path)}
<main id="main" tabindex="-1" class="${wide ? "wide" : "cap-page"}">
${path === "/" ? "" : manualHead(path)}${numbered(body, path)}
${titleBlock(path, asOf)}
</main>
${footer(asOf)}
</body>
</html>
`;
}

// explorer.js wires it.
/** @param {string} here the current section @param {string} path */
function header(here, path) {
  const current = NAV.find(([href]) => href === here || href === path)?.[1];
  return letterheadHtml({
    name: "Capsid",
    mark: '<img src="/icon.svg" alt="" width="32" height="32">',
    links: NAV.map(([href, label]) => [href, href === "/" ? "Home" : label]),
    current: current === "Overview" ? "Home" : current,
    search: { action: "/search/", label: "Search Capsid" },
  });
}

// The section is n.0 and each heading n.1, n.2 and on, as the NASA Graphics Standards Manual numbers its parts.
const SECTIONS = [...NAV, ["/search/", "Search"]].map(([href, label], i) => ({
  href,
  label,
  no: i + 1,
}));

/** @param {string} href */
export const sectionAt = (href) => SECTIONS.find((section) => section.href === href);

// Search is a section of its own here.
/** @param {string} path */
const sectionFor = (path) => sectionAt(path === "/search/" ? path : navSection(path));

// A plain head, so it never stacks a second dark slab under the letterhead; the site is named in the header, not here.
/** @param {string} path */
export function manualHead(path) {
  const section = sectionFor(path);
  if (!section) return "";
  return `<div class="cap-running-head" aria-hidden="true"><span class="cap-running-head-name"><span class="cap-running-head-no">${section.no}</span>${section.label}</span></div>`;
}

/** @param {string} path @param {string} asOf */
export function titleBlock(path, asOf) {
  const section = sectionFor(path);
  if (!section) return "";
  const cell = (/** @type {string} */ label, /** @type {string} */ value, bold = false) =>
    `<div class="cap-form-boxes-box"${bold ? ' data-weight="bold"' : ""}><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<dl class="cap-form-boxes title-block" aria-hidden="true">${cell("Site", ORIGIN.replace("https://", ""))}${cell("Section", `${section.no} ${section.label}`)}${cell("Data of", escapeHtml(asOf))}${cell("Page", section.href === path ? `${section.no}.0` : String(section.no), true)}</dl>`;
}

// A heading kept for screen readers alone keeps no number, nor does one inside a Capsomer component or one marked
// plain (a flow's steps, swapped in place).
/** @param {string} body @param {string} path */
export function numbered(body, path) {
  const section = sectionFor(path);
  if (!section) return body;
  let n = 0;
  return body.replace(/<h2(\s[^>]*)?>/g, (tag, attrs = "") =>
    /class="cap-|data-plain/.test(attrs) ? tag : `<h2${attrs} data-no="${section.no}.${++n}">`,
  );
}

/** @param {string} asOf */
function footer(asOf) {
  /** @param {{ href: string, label: string, no: number }} s */
  const link = ({ href, label, no }) =>
    `<li><a href="${href}"><span class="foot-no" aria-hidden="true">${no}.0</span>${label}</a></li>`;
  const half = Math.ceil(SECTIONS.length / 2);
  const center = `<div class="cap-family-footer-center">
<div><p class="cap-family-footer-center-name">Capsid</p><p class="cap-family-footer-about">An open-source MCP server for AI coding agents. This site runs on one live Capsid server and rebuilds every day from its public data.</p></div>
<div class="cap-family-footer-columns">
<nav aria-label="Every section"><ul class="cap-family-footer-links">${SECTIONS.slice(0, half).map(link).join("")}</ul></nav>
<ul class="cap-family-footer-links" aria-label="More sections">${SECTIONS.slice(half).map(link).join("")}</ul>
<ul class="cap-family-footer-links"><li><a href="https://github.com/DrDustinEdwards/capsid">Source, MIT licensed</a></li><li><a href="https://github.com/DrDustinEdwards/capsid#installation">Install it</a></li></ul>
</div>
<p class="cap-family-footer-stamp"><span>Data as of ${escapeHtml(asOf)}</span><span>Days counted to midnight UTC</span><span>Private systems shown without links to their code</span></p>
</div>`;
  return `<footer class="foot"><div class="cap-page">${familyFooterHtml({ site: "capsid", center, statement: STATEMENT_PATH })}</div></footer>`;
}

/** @param {Array<[string, string]>} trail earlier pages as [href, name] @param {string} here @param {string} title @param {string} [lead] html */
export function pageHead(trail, here, title, lead) {
  const crumbs = trail.length
    ? `<nav class="cap-direction crumbs" aria-label="Breadcrumb"><ol>${trail.map(([href, name]) => `<li><a href="${href}">${escapeHtml(name)}</a></li>`).join("")}<li><span aria-current="page">${escapeHtml(here)}</span></li></ol></nav>`
    : "";
  return `<div class="page-head cap-layout-grid">${crumbs}<h1>${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ""}</div>`;
}

/** @param {number} total @param {number} n */
export const rollBlocks = (total, n) =>
  `<ol class="cap-roll" aria-hidden="true">${Array.from({ length: total }, (_, i) => `<li data-state="${i + 1 < n ? "done" : i + 1 === n ? "now" : "ahead"}"></li>`).join("")}</ol>`;

/** @param {Flow} f @param {string} no the flow's number, as 3.1 */
const patch = (f, no) =>
  patchSvg({ id: f.id, name: f.name, foot: `Capsid ${no}`, count: f.steps.length, unit: "steps" });

/** @param {string} value @param {string} label @param {string} [href] */
export const readingBox = (value, label, href) =>
  `<div class="cap-form-boxes-box"><dt>${href ? `<a href="${href}">${escapeHtml(label)}</a>` : escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;

export const mapData = (/** @type {any} */ model) => modelMapData(model, systemPath);

/** @param {any} model @param {import("capsomer/behavior/system-map").SystemMapOptions} options */
const familyMap = (model, options) =>
  systemMapHtml({ ...mapData(model), flows: mapFlows(flowsOf(model)) }, options);

// A table wider than a phone scrolls in its own box, which a keyboard can reach, rather than widening the page.
/** @param {string} id @param {string} inner @param {string} label */
export const scroller = (id, inner, label) =>
  `<div class="scroller" id="${id}" role="region" aria-label="${escapeHtml(label)}" tabindex="0">${inner}</div>`;

/** @param {string} value @param {string} label @param {string} [href] */
export const reading = (value, label, href) =>
  `<div class="reading"><dt>${href ? `<a href="${href}">${escapeHtml(label)}</a>` : escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;

// The model writes each step as "Name: what happens"; one without a name is called by its number.
/** @param {{ n: number, text: string }} st */
export function stepWords(st) {
  const [head, ...rest] = st.text.split(": ");
  const said = rest.length ? rest.join(": ") : st.text;
  return {
    name: rest.length ? head : `Step ${st.n}`,
    text: said.charAt(0).toUpperCase() + said.slice(1),
  };
}

/** A rate as a whole percent, or to one place where rounding would say all or none when it was not (99.9% up). */
export const percent = (/** @type {number | null} */ rate) => {
  if (rate === null) return "not enough data yet";
  const whole = Math.round(rate * 100);
  return (whole === 100 && rate < 1) || (whole === 0 && rate > 0)
    ? `${(Math.floor(rate * 1000) / 10).toFixed(1)}%`
    : `${whole}%`;
};
export const minutes = (/** @type {number | null} */ m) =>
  m === null ? "not enough data yet" : m < 120 ? `${m} minutes` : `${Math.round(m / 60)} hours`;

/** @param {any} model @param {string} id @param {string} asOf @param {any[]} [maps] its code maps, if it has any @param {any} [home] the system whose code pages hold its repo, when it shares one */
export function systemPage(model, id, asOf, maps = [], home) {
  const s = model.systems.find((/** @type {any} */ x) => x.id === id);
  if (!s) throw new Error(`no system ${id}`);
  const parts = model.containers.filter((/** @type {any} */ c) => c.system === id);
  const own = ownParts(parts);
  const repos = !s.private && !s.hide_repo_link ? (s.repos ?? []) : [];
  const ties = tiesOf(mapData(model)).get(id);
  const connections = (ties?.uses.length ?? 0) + (ties?.usedBy.length ?? 0);
  const facts = [
    ["Ring", RING_NAMES[/** @type {keyof typeof RING_NAMES} */ (s.ring)]],
    ["Kind", s.family],
    ...(s.domain
      ? [["Address", `<a href="https://${escapeHtml(s.domain)}">${escapeHtml(s.domain)}</a>`]]
      : []),
    ...(repos.length
      ? [
          [
            "Source",
            repos
              .map(
                (/** @type {string} */ r) =>
                  `<a href="${escapeHtml(r)}">${escapeHtml(r.replace(/^https:\/\/github\.com\//, "")).replace("/", "/<wbr>")}</a>`,
              )
              .join("<br>"),
          ],
        ]
      : []),
    ["Visibility", s.private ? "Private" : "Public"],
    ...(own.length ? [["Parts", `<a href="${containersPath(id)}">${own.length}</a>`]] : []),
    ["Connections", String(connections)],
    ...(maps.length
      ? [["Code", `<a href="${codePath(id)}">${escapeHtml(codeSummary(maps))}</a>`]]
      : home
        ? [
            [
              "Code",
              `<a href="${codePath(home.id)}">Measured with ${escapeHtml(home.name)}, which shares its repo</a>`,
            ],
          ]
        : []),
    ["Write-up", `<a href="${sitePath(id)}">${escapeHtml(s.name)} on dustinedwards.info</a>`],
  ];
  const lead = s.description
    ? escapeHtml(s.description)
    : s.private
      ? "Private: its repo is not public."
      : "";
  const drawing = `<div class="map-host">${familyMap(model, { id: "system-map", system: id, label: `${s.name} in the network`, headingLevel: 3 })}</div>`;
  const body = `${pageHead(
    [
      ["/", "Overview"],
      ["/systems/", "Systems"],
    ],
    s.name,
    escapeHtml(s.name),
    lead,
  )}
<dl class="readings readings-facts">${facts.map(([k, v]) => `<div class="reading"><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>
<section aria-labelledby="inside-title"><h2 id="inside-title">How it connects</h2>
${own.length ? `<p class="section-sub"><a href="${containersPath(id)}">Inside ${escapeHtml(s.name)}</a></p>` : ""}
${drawing}</section>
${flowLinks(model, id)}
${maps.length ? riskiest(id, maps) : ""}`;
  return layout({
    title: s.name,
    description: `${s.description ?? (s.private ? `${s.name} is private.` : s.name)} ${own.length ? `Its ${own.length} parts and ${connections} connections` : `Its ${connections} connections`}${maps.length ? ", and its code scored for risk" : ""}, on Capsid's map of the network.`,
    path: systemPath(id),
    body,
    asOf,
  });
}

// `external` containers (Agents, GitHub) are what it works with outside its boundary.
/** @param {any[]} parts */
const ownParts = (parts) => parts.filter((c) => c.kind !== "external");

/** @param {any} model @param {string} id @param {string} asOf */
export function containersPage(model, id, asOf) {
  const s = model.systems.find((/** @type {any} */ x) => x.id === id);
  const parts = model.containers.filter((/** @type {any} */ c) => c.system === id);
  if (!s || parts.length === 0) throw new Error(`no containers page for ${id}`);
  const own = ownParts(parts);
  const outside = parts.filter((/** @type {any} */ c) => c.kind === "external");
  const byId = new Map(parts.map((/** @type {any} */ c) => [c.id, c]));
  const wires = model.relationships.filter(
    (/** @type {any} */ r) => byId.has(r.from) && byId.has(r.to),
  );
  // The lead and the description say the same, so a search result reads as the page does.
  const inside = `${own.length === 1 ? "its one part, what it runs on, and how it connects" : `its ${own.length} parts, what each runs on, and how they connect`}${outside.length ? `, plus ${outside.length === 1 ? "the one outside system" : `the ${outside.length} outside systems`} it works with` : ""}`;
  const body = `${pageHead(
    [
      ["/", "Overview"],
      ["/systems/", "Systems"],
      [systemPath(id), s.name],
    ],
    "Inside",
    `Inside ${escapeHtml(s.name)}`,
    `${inside[0].toUpperCase()}${inside.slice(1)}.`,
  )}
${scroller(
  "parts",
  `<table class="cap-table"><caption>The parts of ${escapeHtml(s.name)}</caption>
<thead><tr><th scope="col">Part</th><th scope="col">Kind</th><th scope="col">Runs on</th><th scope="col">What it does</th></tr></thead>
<tbody>${own.map((/** @type {any} */ c) => `<tr id="part-${escapeHtml(c.id)}"><th scope="row">${escapeHtml(c.name)}</th><td>${escapeHtml(c.kind)}</td><td>${escapeHtml(c.technology)}</td><td data-wrap>${escapeHtml(c.description ?? "")}</td></tr>`).join("")}</tbody></table>`,
  `The parts of ${s.name}`,
)}
${
  outside.length
    ? `<section aria-labelledby="outside-title"><h2 id="outside-title">Outside it</h2>
<ul>${outside.map((/** @type {any} */ c) => `<li id="part-${escapeHtml(c.id)}"><strong>${escapeHtml(c.name)}</strong> (${escapeHtml(c.technology)})${c.description ? `: ${escapeHtml(c.description)}` : ""}</li>`).join("")}</ul>
</section>`
    : ""
}
<section aria-labelledby="wires-title"><h2 id="wires-title">How they connect</h2>
${wires.length ? `<ul class="wires">${wires.map((/** @type {any} */ r) => `<li>${escapeHtml(byId.get(r.from).name)} <span class="verb">${escapeHtml(VERB[/** @type {keyof typeof VERB} */ (r.kind)]?.[0] ?? r.kind)}</span> ${escapeHtml(byId.get(r.to).name)}</li>`).join("")}</ul>` : "<p>None drawn.</p>"}
</section>
${flowLinks(model, id)}`;
  return layout({
    title: `Inside ${s.name}`,
    description: `Inside ${s.name}: ${inside}, on Capsid's map of the network.`,
    path: containersPath(id),
    parent: [systemPath(id), s.name],
    body,
    asOf,
  });
}

/** @param {any} model @param {Map<string, any[]>} bySystem @param {string} asOf */
export function systemsPage(model, bySystem, asOf) {
  const map = familyMap(model, {
    id: "family",
    label: "Every system, by what it is for",
    caption:
      "Capsid at the core, the shared packages around it, and what people use, by group, on the outside. Point at a system to light what it uses and what uses it, or open it.",
    headingLevel: 2,
  });
  const ties = tiesOf(mapData(model));
  const count = (/** @type {string} */ id) =>
    (ties.get(id)?.uses.length ?? 0) + (ties.get(id)?.usedBy.length ?? 0);
  const modules = (/** @type {string} */ id) =>
    (bySystem.get(id) ?? []).reduce((n, m) => n + m.modules.length, 0);
  const rows = model.systems
    .map(
      (/** @type {any} */ s) =>
        `<tr data-item data-kinds="${escapeHtml(s.ring)}${s.private ? " private" : ""}" data-text="${escapeHtml(`${s.name} ${s.domain ?? ""} ${s.family} ${s.description ?? ""}`.toLowerCase())}"><th scope="row"><a href="${systemPath(s.id)}">${escapeHtml(s.name)}</a></th><td>${escapeHtml(RING_NAMES[/** @type {keyof typeof RING_NAMES} */ (s.ring)])}</td><td>${escapeHtml(s.family)}</td><td>${s.domain ? escapeHtml(s.domain) : ""}</td><td data-sort="${ownParts(model.containers.filter((/** @type {any} */ c) => c.system === s.id)).length}">${ownParts(model.containers.filter((/** @type {any} */ c) => c.system === s.id)).length}</td><td data-sort="${count(s.id)}">${count(s.id)}</td><td data-sort="${modules(s.id)}">${modules(s.id) || ""}</td><td>${s.private ? "Private" : "Public"}</td></tr>`,
    )
    .join("");
  const chips = [
    ["all", "All"],
    ["core", "Runs everything"],
    ["shared", "Shared parts"],
    ["used", "What people use"],
    ["private", "Private"],
  ];
  const body = `${pageHead([], "Systems", "The network of systems")}
<section aria-labelledby="family-title">${map}</section>
<section aria-labelledby="table-title"><h2 id="table-title">Every system</h2>
<div class="filter-bar" data-filter="systems" hidden>
<label class="cap-sr-only" for="sys-q">Filter the systems</label>
<input class="cap-input" id="sys-q" type="search" placeholder="Filter by name, address or kind" autocomplete="off" data-filter-q>
<div class="chips" role="group" aria-label="Show">${chips.map(([k, label], i) => `<button type="button" class="cap-btn" data-size="sm" data-chip="${k}" aria-pressed="${i ? "false" : "true"}">${label}</button>`).join("")}</div>
<p class="hint" role="status" data-filter-count></p>
</div>
${scroller(
  "systems-table",
  `<table class="cap-table" data-sortable><caption>Every system, with its parts, connections and measured modules</caption>
<thead><tr><th scope="col">System</th><th scope="col">Ring</th><th scope="col">Kind</th><th scope="col">Address</th><th scope="col">Parts</th><th scope="col">Connections</th><th scope="col">Modules</th><th scope="col">Visibility</th></tr></thead>
<tbody>${rows}</tbody></table>`,
  "Every system table",
)}
<p class="hint" data-filter-empty hidden>No system matches that.</p>
</section>`;
  return layout({
    title: "Systems",
    description: `The ${model.systems.length} systems this Capsid server runs and how they connect, with Capsid at the core.`,
    path: "/systems/",
    body,
    asOf,
  });
}

/**
 * @typedef {{ id: string, system: string, name: string }} Part
 * @typedef {{ n: number, from: Part, to: Part, toward: string, kind: string, text: string, lights: Part[], touches: Part[] }} Step
 * @typedef {{ id: string, name: string, description?: string, steps: Step[] }} Flow
 */

// Everything is public (a private system only lacks its repo link), so the build stops only for a line the map
// lacks or a part it does not hold (design section 4).
/** @param {any} model @param {any} flow @returns {Flow} */
export function resolveFlow(model, flow) {
  const edges = new Map(model.relationships.map((/** @type {any} */ r) => [r.id, r]));
  const parts = new Map(model.containers.map((/** @type {any} */ c) => [c.id, c]));
  const steps = flow.steps.map((/** @type {any} */ st, /** @type {number} */ i) => {
    const where = `flow ${flow.id} step ${i + 1}`;
    /** @param {string} id @returns {Part} */
    const part = (id) => {
      const c = parts.get(id);
      if (!c) throw new Error(`${where} touches ${id}, which is not a part in the public model`);
      return { id: c.id, system: c.system, name: c.name };
    };
    const edge = edges.get(st.relationship);
    if (!edge)
      throw new Error(
        `${where} rides ${st.relationship}, which is not a relationship in the public model`,
      );
    if (st.toward !== edge.from && st.toward !== edge.to)
      throw new Error(`${where} goes toward ${st.toward}, which is not an end of ${edge.id}`);
    const from = part(edge.from);
    const to = part(edge.to);
    const lights = (st.lights ?? []).map(part);
    const touches = [from, to, ...lights].filter(
      (p, k, all) => all.findIndex((q) => q.id === p.id) === k,
    );
    return {
      n: i + 1,
      from,
      to,
      toward: st.toward,
      kind: edge.kind,
      text: st.text,
      lights,
      touches,
    };
  });
  return { id: flow.id, name: flow.name, description: flow.description, steps };
}

/** @param {any} model @returns {Flow[]} */
export const flowsOf = (model) =>
  (model.flows ?? []).map((/** @type {any} */ f) => resolveFlow(model, f));

/** @param {any} model @param {string} id */
function flowLinks(model, id) {
  const flows = flowsOf(model).filter((f) =>
    f.steps.some((st) => st.touches.some((p) => p.system === id)),
  );
  if (!flows.length) return "";
  return `<section aria-labelledby="flows-title"><h2 id="flows-title">Flows through it</h2>
<ul>${flows.map((f) => `<li><a href="${flowPath(f.id)}">${escapeHtml(f.name)}</a>, in ${f.steps.length} steps${f.description ? `: ${escapeHtml(f.description)}` : ""}</li>`).join("")}</ul>
</section>`;
}

/** @param {Step} st @param {Part} p */
function role(st, p) {
  const end = p.id === st.from.id || p.id === st.to.id;
  if (end && p.id === st.toward) return "step arrives";
  if (end) return "step starts";
  return "also used";
}

/** @param {Flow} f @param {number} [current] */
function stepList(f, current) {
  return `<ol class="flow-steps" data-swap="steps">${f.steps
    .map((st) => {
      const w = stepWords(st);
      return `<li><a href="${stepPath(f.id, st.n)}" data-go="${st.n}"${st.n === current ? ' aria-current="step"' : ""}><span class="step-name">${escapeHtml(w.name)}</span> ${escapeHtml(w.text)}</a></li>`;
    })
    .join("")}</ol>`;
}

/** @param {Flow[]} flows */
const mapFlows = (flows) =>
  flows.map((f) => ({
    id: f.id,
    name: f.name,
    description: f.description,
    steps: f.steps.map((x) => ({
      from: x.from.id,
      to: x.to.id,
      toward: x.toward,
      text: x.text,
      lights: x.lights.map((p) => p.id),
    })),
  }));

// The first touched on a tie.
/** @param {any} model @param {Flow} f */
function flowHome(model, f) {
  /** @type {Map<string, number>} */
  const n = new Map();
  for (const st of f.steps) for (const p of st.touches) n.set(p.system, (n.get(p.system) ?? 0) + 1);
  const best = [...n].reduce((a, b) => (b[1] > a[1] ? b : a), ["", 0])[0];
  return model.systems.find((/** @type {any} */ s) => s.id === best);
}

/** @param {any} model @param {Flow} f @param {number} n @param {string} id @param {2 | 3} level */
function flowMap(model, f, n, id, level) {
  const home = flowHome(model, f);
  return systemMapHtml(
    { ...mapData(model), flows: mapFlows([f]) },
    {
      id,
      system: home.id,
      only: "inside",
      label: `${f.name}, over the parts of ${home.name}`,
      headingLevel: level,
      flow: { id: f.id, step: n },
    },
  );
}

/** @param {any} model @param {Flow} f @param {string} asOf */
export function flowPage(model, f, asOf) {
  const stage = flowStage(model, [f], f, "flow-map");
  const no = `${sectionAt("/flows/")?.no}.${flowsOf(model).findIndex((x) => x.id === f.id) + 1}`;
  const body = `<div class="patched">${pageHead(
    [
      ["/", "Overview"],
      ["/flows/", "Flows"],
    ],
    f.name,
    escapeHtml(f.name),
    escapeHtml(f.description ?? `${f.steps.length} steps.`),
  )}${patch(f, no)}</div>
${stage ? `<div class="flow-stage" data-ui>${stage}</div>` : ""}
<section aria-labelledby="steps-title"><h2 id="steps-title">Every step</h2>${bands(f)}</section>
<p><a class="cap-btn" data-variant="primary" href="${stepPath(f.id, 1)}">Step through it, one page a step</a></p>`;
  return layout({
    title: f.name,
    description: f.description ?? f.name,
    path: flowPath(f.id),
    body,
    asOf,
  });
}

// brief: the names alone, for the list of every flow.
/** @param {Flow} f @param {boolean} [brief] */
export const bands = (f, brief = false) =>
  `<ol class="bands${brief ? " bands-brief" : ""}">${f.steps
    .map((st) => {
      const w = stepWords(st);
      return brief
        ? `<li><a href="${stepPath(f.id, st.n)}"><span class="band-name">${escapeHtml(w.name)}</span></a></li>`
        : `<li><a href="${stepPath(f.id, st.n)}"><span class="band-text"><span class="band-name">${escapeHtml(w.name)}</span>${escapeHtml(w.text)}</span><span class="band-parts">${st.touches.map((p) => `<span class="part-name">${escapeHtml(p.name)}</span>`).join("")}</span></a></li>`;
    })
    .join("")}</ol>`;

// Play steps it in place, with no change of address (src/explorer.js, player).
/** @param {any} model @param {Flow[]} flows every flow the drawing can switch to @param {Flow} shown @param {string} id @param {boolean} [play] whether a Play button follows it (the tour steps it by scrolling instead) */
export function flowStage(model, flows, shown, id, play = true) {
  const map = flowMap(model, shown, 1, id, 2);
  const host = `<div class="map-host flow-map" data-flow="${escapeHtml(shown.id)}" data-step="1" data-steps="${shown.steps.length}" data-player>${map}</div>`;
  if (!play) return host;
  return `${host}
<p class="hero-play"><button class="cap-btn" type="button" data-autoplay hidden>Play</button></p>`;
}

/** @param {any} model @param {string} asOf */
export function flowsIndexPage(model, asOf) {
  const flows = flowsOf(model);
  const body = `${pageHead([], "Flows", "What runs, step by step")}
<ul class="flow-cards">${flows
    .map((f, i) => {
      return `<li class="flow-card" data-livery>${patch(f, `${sectionAt("/flows/")?.no}.${i + 1}`)}<h2><a href="${flowPath(f.id)}">${escapeHtml(f.name)}</a></h2>
<p>${escapeHtml(f.description ?? "")}</p>
${bands(f, true)}
<p><a class="cap-btn" data-variant="primary" href="${flowPath(f.id)}">Watch it run</a></p></li>`;
    })
    .join("")}</ul>`;
  return layout({
    title: "Flows",
    description: `The ${flows.length} processes Capsid runs, each shown step by step on the parts of Capsid it uses.`,
    path: "/flows/",
    body,
    asOf,
  });
}

// Every other step is laid in the same grid cell, unseen and out of the accessibility tree, so the section is as tall
// as the longest step and stepping never moves the drawing (design section 6, CLS); the copies carry no id or link.
/** @param {Step} st @param {number} total @param {Map<string, any>} systems @param {boolean} shown @param {string} name the flow's */
function stepText(st, total, systems, shown, name) {
  const link = (/** @type {string} */ href, /** @type {string} */ text, cls = "") =>
    shown
      ? `<a${cls ? ` class="${cls}"` : ""} href="${href}">${text}</a>`
      : `<span${cls ? ` class="${cls}"` : ""}>${text}</span>`;
  const parts = st.touches
    .map(
      (p) =>
        `<li${shown ? ` data-part="${escapeHtml(p.id)}"` : ""}>${link(partPath(p), escapeHtml(p.name), "cap-cue-name")}<span class="cap-cue-value touch-role">${role(st, p)}</span><span class="touch-in">in ${link(systemPath(p.system), escapeHtml(systems.get(p.system)?.name ?? p.system))}</span></li>`,
    )
    .join("");
  return `<div class="${shown ? "cap-cue" : "cap-cue flow-unseen"}"${shown ? "" : ' aria-hidden="true" inert'}>
<p class="cap-cue-strip" aria-hidden="true"><span>${escapeHtml(name)}</span><span>Card ${st.n}</span></p>
${rollBlocks(total, st.n)}
<h2${shown ? ' id="step-title"' : ""} data-plain>Step ${st.n} of ${total}</h2>
<p class="cap-cue-title step-head">${escapeHtml(stepWords(st).name)}</p>
<p class="flow-text">${escapeHtml(stepWords(st).text)}</p>
<h3>What it touches</h3>
<ul class="cap-cue-lines flow-touches">${parts}</ul>
</div>`;
}

/** @param {any} model @param {Flow} f @param {number} n @param {string} asOf */
export function stepPage(model, f, n, asOf) {
  const st = f.steps[n - 1];
  if (!st) throw new Error(`flow ${f.id} has no step ${n}`);
  const total = f.steps.length;
  const systems = new Map(model.systems.map((/** @type {any} */ s) => [s.id, s]));
  const map = flowMap(model, f, n, "family", 3);
  const nav = [
    n > 1
      ? `<a rel="prev" href="${stepPath(f.id, n - 1)}" data-go="${n - 1}" class="cap-sign">Back<span class="cap-sr-only">: step ${n - 1}</span></a>`
      : "",
    n < total
      ? `<a rel="next" href="${stepPath(f.id, n + 1)}" data-go="${n + 1}" class="cap-sign">Next<span class="cap-sr-only">: step ${n + 1}</span></a>`
      : "",
  ].join("");
  // Play steps through on its own; the script shows it, since without script there is nothing to play.
  const play = `<button class="cap-btn" type="button" data-autoplay hidden>Play</button>`;
  const body = `${pageHead(
    [
      ["/", "Overview"],
      ["/flows/", "Flows"],
      [flowPath(f.id), f.name],
    ],
    `Step ${n}`,
    escapeHtml(f.name),
  )}
<div class="step-layout step-layout-drawn">
<section class="flow-step" data-swap="step" aria-labelledby="step-title">
<div class="flow-stack">${f.steps.map((x) => stepText(x, total, systems, x.n === n, f.name)).join("")}</div>
<nav class="flow-nav" aria-label="Steps">${nav}${play}</nav>
</section>
<section class="step-drawing" aria-labelledby="drawing-title"><h2 id="drawing-title" class="cap-sr-only">The drawing</h2><div class="map-host flow-map" data-flow="${escapeHtml(f.id)}" data-step="${n}" data-steps="${total}">${map}</div><p class="hint" data-keys hidden>Number keys 1 to ${Math.min(total, 9)} go to that step.</p></section>
</div>
<section aria-labelledby="steps-title"><h2 id="steps-title">Every step</h2>${stepList(f, n)}</section>`;
  return layout({
    title: `${f.name}, step ${n} of ${total}`,
    parent: [flowPath(f.id), f.name],
    // A step's own sentence can be short for a search result; its place in the flow says the rest.
    description: `${st.text} Step ${n} of ${total} of ${f.name}.`,
    path: stepPath(f.id, n),
    body,
    asOf,
  });
}

const STATEMENT_PATH = "/accessibility/";

// Prelum's statement with this site's facts; no limitation of its own is open (devkit-a11y).
/** @param {string} asOf */
export function accessibilityPage(asOf) {
  const statement = accessibilityStatement({
    siteName: "The Capsid explorer",
    contact: {
      href: "https://dustinedwards.info/contact",
      label: "the contact page on dustinedwards.info",
    },
    date: "2026-11-01",
    capsomer: true,
    links: "marked",
  });
  return layout({
    title: statement.title,
    description: statement.description,
    path: STATEMENT_PATH,
    body: `<h1>${escapeHtml(statement.title)}</h1>\n<div class="statement">${statement.html}</div>`,
    asOf,
  });
}

/** @param {string} asOf */
export function notFoundPage(asOf) {
  return layout({
    title: "Not found",
    description: "No page here.",
    path: "/404",
    body: `<h1>Nothing here</h1><p class="lead">No page lives at this address. Try <a href="/systems/">the systems</a> or <a href="/search/">search</a>.</p>`,
    asOf,
  });
}

/** @param {any} model @param {any} stats @param {any} [code] @param {any[]} [tools] @returns {Array<[string, string]>} */
export function allPages(model, stats, code = null, tools = []) {
  const asOf = stats.as_of;
  const bySystem = codeBySystem(model, code);
  const totals = codeTotals(model, bySystem);
  /** @type {Array<[string, string]>} */
  const pages = [
    ["/", homePage(model, stats, tools, totals)],
    ["/systems/", systemsPage(model, bySystem, asOf)],
    ["/flows/", flowsIndexPage(model, asOf)],
    ["/numbers/", numbersPage(stats)],
    ["/code/", codeIndexPage(model, bySystem, totals, asOf)],
    ["/search/", searchPage(asOf)],
  ];
  for (const s of model.systems) {
    pages.push([
      systemPath(s.id),
      systemPage(model, s.id, asOf, bySystem.get(s.id), codeHome(model, bySystem, s.id)),
    ]);
    if (model.containers.some((/** @type {any} */ c) => c.system === s.id))
      pages.push([containersPath(s.id), containersPage(model, s.id, asOf)]);
  }
  for (const f of flowsOf(model)) {
    pages.push([flowPath(f.id), flowPage(model, f, asOf)]);
    for (const st of f.steps) pages.push([stepPath(f.id, st.n), stepPage(model, f, st.n, asOf)]);
  }
  pages.push(...toolPages(tools, asOf));
  pages.push(...codePages(model, bySystem, asOf));
  pages.push([STATEMENT_PATH, accessibilityPage(asOf)]);
  pages.push(["/404", notFoundPage(asOf)]);
  return pages;
}

/** @param {any} model @param {any} code @param {any[]} tools */
export const searchDocument = (model, code, tools) =>
  searchIndex(model, codeBySystem(model, code), flowsOf(model), tools);
