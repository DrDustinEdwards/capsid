// The explorer's pages, as HTML strings from the public model and numbers
// (capsid/research/design-system-explorer.md, section 4; slice 5 of its build order).
// Pure: no file, network or clock. build.mjs writes what these return; the tests read them.
//
// Every address is a prerendered page with its content in the HTML. A private system has a
// page that says it is private, so no link to one 404s. Every system page links to the same
// system on dustinedwards.info, and that site's pages link back (section 4, "Deep links both
// ways"). Times of day never appear: the documents carry a date and nothing finer.
import { modelMapData, systemMapHtml } from "capsomer/behavior/system-map";
import { circleLayers } from "capsomer/system-map-circles";
import { patchSvg } from "capsomer/behavior/manual";
import { familyFooterHtml } from "capsomer/behavior/family-footer";
import { letterheadHtml } from "capsomer/behavior/site-header";
import { escapeHtml } from "@dustinedwards/site-runtime/html";
import { defineHead, headHtml } from "@drdustinedwards/site-helpers/head";
import { iconLinks } from "@drdustinedwards/site-helpers/icons";
import { jsonLd } from "@drdustinedwards/site-helpers/schema";

import { codeBySystem, codeHome, codeIndexPage, codePages, codePath, codeSummary, codeTotals, riskiest } from "./code.mjs";
import { graphSvg } from "./graph.mjs";
import { homePage } from "./home.mjs";
import { numbersPage } from "./numbers.mjs";
import { searchIndex, searchPage } from "./search.mjs";
import { toolPages } from "./tools.mjs";

export const SITE = "https://dustinedwards.info";
export const ORIGIN = "https://capsid.dustinedwards.info";
/** The IndexNow key, served as /<key>.txt (build.mjs) and sent by indexnow.mjs after a deploy. Public by design. */
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

// The family's one escaper (site-runtime ./html), for any value; code.mjs and graph.mjs take it from here.
export { escapeHtml };

/** @param {string} id */
export const systemPath = (id) => `/s/${id}/`;
/** @param {string} id */
export const containersPath = (id) => `/s/${id}/containers/`;
/** @param {string} id */
export const sitePath = (id) => `${SITE}/systems/${id}`;
/** @param {string} id */
export const flowPath = (id) => `/flows/${id}/`;
/** A flow's step, counted from 1, as the design writes it (/flows/job-life/4/). @param {string} id @param {number} n */
export const stepPath = (id, n) => `/flows/${id}/${n}/`;
/** Where a part is listed: its row on its system's parts page. @param {{ id: string, system: string }} c */
export const partPath = (c) => `${containersPath(c.system)}#part-${c.id}`;

/** The sections every page leads to, in the bar at the top and the footer. */
export const NAV = [
  ["/", "Overview"],
  ["/systems/", "Systems"],
  ["/flows/", "Flows"],
  ["/tools/", "Tools"],
  ["/numbers/", "Numbers"],
  ["/code/", "Code"],
];

const NAMES = Object.fromEntries(NAV);
/** The pages that list a kind of thing, written as CollectionPage. */
const LISTS = ["/systems/", "/flows/", "/tools/", "/code/"];

/** The section a path belongs to, for the bar's aria-current. @param {string} path */
function sectionOf(path) {
  if (path === "/") return "/";
  if (/^\/s\/[^/]+\/code\//.test(path)) return "/code/";
  if (path.startsWith("/s/")) return "/systems/";
  return NAV.find(([href]) => href !== "/" && path.startsWith(href))?.[0] ?? "";
}

/**
 * The card every page shares (src/og-card.png): a travel poster in the manner of JPL's Visions of
 * the Future (2016), after the 1930s national-park posters, flat layered shapes in the family's
 * teal under an amber sun. Drawn by og-card.mjs.
 */
export const CARD = { url: "/assets/og-card.png", width: 1200, height: 630, alt: "A travel poster: Visit Capsid. AI agents say it's done. Capsid checks." };
const head = defineHead({ origin: ORIGIN, siteName: "Capsid", image: CARD, suffix: ", Capsid", locale: "en_US" });

const ICON_LINKS = iconLinks()
  .map((link) => `<link ${Object.entries(link).map(([name, value]) => `${name}="${value}"`).join(" ")}>`)
  .join("\n");

/**
 * The page around a body: one stylesheet set, the theme script and one module script, no inline
 * script or style, so the policy in _headers needs no hash (src/security-headers.mjs); JSON-LD is
 * data, not script, so the policy does not apply to it. The head's tags are Prelum's, with the
 * production origin, so the 404 says noindex and claims no canonical. `title` is the page's own, before
 * ", Capsid"; `parent` is the page between its section and it in its breadcrumb trail. A wide page's
 * sections set their own width, for the front page's full-bleed parts; any other page is one column.
 * @param {{ title: string, description: string, path: string, body: string, asOf: string, wide?: boolean, data?: Record<string, unknown>[], fullTitle?: boolean, parent?: [string, string] }} page
 */
export function layout({ title, description, path, body, asOf, wide = false, data = [], fullTitle, parent }) {
  const here = sectionOf(path);
  const missing = path === "/404";
  // Every page is served at its slash, so the canonical and the trail keep it (Prelum's own trail drops it).
  const section = here && here !== "/" && here !== path ? [[here, NAMES[here]]] : [];
  const trail = [["/", NAMES["/"]], ...section, ...(parent ? [parent] : []), [path, title]].map(([href, name]) => ({ name, path: href }));
  const pageType = LISTS.includes(path) ? "CollectionPage" : undefined;
  const tags = head({ path, title, fullTitle, description, noindex: missing, keepTrailingSlash: true, breadcrumbs: path === "/" ? false : trail, pageType });
  const headMarkup = headHtml([...tags.filter((tag) => !(missing && "tagName" in tag && tag.rel === "canonical")), ...data.map(jsonLd)]);
  return `<!doctype html>
<html lang="en" data-cap-site="capsid" data-family="teal">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${headMarkup}
${ICON_LINKS}
<link rel="preload" href="/fonts/schibsted-grotesk-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/capsomer.css">
<link rel="stylesheet" href="/assets/enarratio.css">
<link rel="stylesheet" href="/assets/explorer.css">
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

/**
 * The family letterhead (capsomer/site-header): the mark with "Dustin Edwards" over Capsid, search,
 * the theme button, and the sections in a second row, Home first. explorer.js wires it.
 * @param {string} here the current section @param {string} path
 */
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

/**
 * Every section's number, as the NASA Graphics Standards Manual (Danne & Blackburn, 1976) numbers
 * its parts: the section is n.0 and each heading on its pages n.1, n.2 and on.
 */
const SECTIONS = [...NAV, ["/search/", "Search"]].map(([href, label], i) => ({ href, label, no: i + 1 }));

/** A section by its own path. @param {string} href */
export const sectionAt = (href) => SECTIONS.find((section) => section.href === href);

/** The section a page is numbered in: search is a section of its own here. @param {string} path */
const sectionFor = (path) => sectionAt(path === "/search/" ? path : sectionOf(path));

/**
 * A page's head, Capsomer's running head: its section's number and name over the manual's rule (a
 * plain head, not the building sign, so it never stacks a second dark slab under the letterhead). The site is named in the header and the title block, so not again
 * here. The page's own trail and heading follow it as text.
 * @param {string} path
 */
export function manualHead(path) {
  const section = sectionFor(path);
  if (!section) return "";
  return `<div class="cap-running-head" aria-hidden="true"><span class="cap-running-head-name"><span class="cap-running-head-no">${section.no}</span>${section.label}</span></div>`;
}

/**
 * A page's title block, as the foot of every page of the Apollo flight plans (MSC Form 29, 1969)
 * boxes its mission, date and page; the page is numbered as the manual numbers its folios, n.0
 * for a section's own page. @param {string} path @param {string} asOf
 */
export function titleBlock(path, asOf) {
  const section = sectionFor(path);
  if (!section) return "";
  const cell = (/** @type {string} */ label, /** @type {string} */ value, bold = false) =>
    `<div class="cap-form-boxes-box"${bold ? ' data-weight="bold"' : ""}><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<dl class="cap-form-boxes title-block" aria-hidden="true">${cell("Site", ORIGIN.replace("https://", ""))}${cell("Section", `${section.no} ${section.label}`)}${cell("Data of", escapeHtml(asOf))}${cell("Page", section.href === path ? `${section.no}.0` : String(section.no), true)}</dl>`;
}

/**
 * Each visible second-level heading of a page numbered in its section, n.1 onwards, in reading
 * order. A heading kept for screen readers alone keeps no number, nor does one inside a Capsomer
 * component (a drawing's own lists) or one marked plain (a flow's steps, swapped in place).
 * @param {string} body @param {string} path
 */
export function numbered(body, path) {
  const section = sectionFor(path);
  if (!section) return body;
  let n = 0;
  return body.replace(/<h2(\s[^>]*)?>/g, (tag, attrs = "") => (/class="cap-|data-plain/.test(attrs) ? tag : `<h2${attrs} data-no="${section.no}.${++n}">`));
}

/**
 * The close of every page: the family footer every dustinedwards.info site ends with (capsomer/family-footer,
 * Dustin, 2026-10-26), with Capsid's own part under its thin teal stripe: what the site is, every section,
 * where else to go and the day of its data. @param {string} asOf
 */
function footer(asOf) {
  /** @param {{ href: string, label: string, no: number }} s */
  const link = ({ href, label, no }) => `<li><a href="${href}"><span class="foot-no" aria-hidden="true">${no}.0</span>${label}</a></li>`;
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
  return `<footer class="foot"><div class="cap-page">${familyFooterHtml({ site: "capsid", center })}</div></footer>`;
}

/**
 * A page's heading block: the trail to it, its title and its lead sentence. The trail is a
 * direction strip, as the manual's signs point the way (6.2), and the block is drawn on its
 * layout grid, the columns and baseline the manual prints in fine red lines (5.1).
 * @param {Array<[string, string]>} trail earlier pages as [href, name] @param {string} here @param {string} title @param {string} [lead] html
 */
export function pageHead(trail, here, title, lead) {
  const crumbs = trail.length
    ? `<nav class="cap-direction crumbs" aria-label="Breadcrumb"><ol>${trail.map(([href, name]) => `<li><a href="${href}">${escapeHtml(name)}</a></li>`).join("")}<li><span aria-current="page">${escapeHtml(here)}</span></li></ol></nav>`
    : "";
  return `<div class="page-head cap-layout-grid">${crumbs}<h1>${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ""}</div>`;
}

/**
 * A flow's steps as the blocks painted round a Saturn V, which showed the cameras on the ground
 * how far it had rolled: one block a step, filled for those done, lit for the one shown.
 * @param {number} total @param {number} n
 */
export const rollBlocks = (total, n) =>
  `<ol class="cap-roll" aria-hidden="true">${Array.from({ length: total }, (_, i) => `<li data-state="${i + 1 < n ? "done" : i + 1 === n ? "now" : "ahead"}"></li>`).join("")}</ol>`;

/**
 * A flow's patch (Capsomer's patchSvg), as every Apollo crew wore its mission's: the flow's name
 * round the top, its number in the section round the foot, and its steps as dots round the disc.
 * @param {Flow} f @param {string} no the flow's number, as 3.1
 */
const patch = (f, no) => patchSvg({ id: f.id, name: f.name, foot: `Capsid ${no}`, count: f.steps.length, unit: "steps" });

/** A headline figure as one of Capsomer's form boxes, linked to where it is counted. @param {string} value @param {string} label @param {string} [href] */
export const readingBox = (value, label, href) =>
  `<div class="cap-form-boxes-box"><dt>${href ? `<a href="${href}">${escapeHtml(label)}</a>` : escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;

/** The map's data, each system linking to its explorer page: the same as dustinedwards.info's (Capsomer's modelMapData). */
export const mapData = (/** @type {any} */ model) => modelMapData(model, systemPath);

/** Every system's circle, as one JSON object by id, which a map fetches once its page has loaded. */
export const CIRCLES_URL = "/assets/circles.json";
const circleMemo = new WeakMap();

/**
 * Every system's circle (Capsomer's circleLayers), the drawings dustinedwards.info's /systems shows, drawn once per
 * model. The flows go in so that the core's circle carries the token they play with.
 * @param {any} model
 * @returns {Record<string, string>}
 */
export function circlesOf(model) {
  let circles = circleMemo.get(model);
  if (!circles) {
    circles = circleLayers({ ...mapData(model), flows: mapFlows(model, flowsOf(model)) });
    circleMemo.set(model, circles);
  }
  return circles;
}

/**
 * The family map where one tap on any system zooms into its circle, delivered zoomed into `chosen` when given.
 * @param {any} model @param {import("capsomer/behavior/system-map").SystemMapOptions} options @param {any} [data] @param {string} [chosen]
 */
const familyMap = (model, options, data = mapData(model), chosen = undefined) =>
  systemMapHtml(data, { ...options, circles: { src: CIRCLES_URL, layers: chosen ? { [chosen]: circlesOf(model)[chosen] } : {}, chosen } });

/**
 * One system's lines to other systems, read from its end.
 * @param {any} model @param {string} id
 * @returns {Array<{ verb: string, id: string, name: string }>}
 */
export function connectionsOf(model, id) {
  const byId = new Map(model.systems.map((/** @type {any} */ s) => [s.id, s]));
  return model.relationships
    .filter((/** @type {any} */ r) => (r.from === id || r.to === id) && byId.has(r.from) && byId.has(r.to) && r.from !== r.to)
    .map((/** @type {any} */ r) => {
      const out = r.from === id;
      const other = byId.get(out ? r.to : r.from);
      const verb = VERB[/** @type {keyof typeof VERB} */ (r.kind)]?.[out ? 0 : 1] ?? r.kind;
      return { verb: verb.charAt(0).toUpperCase() + verb.slice(1), id: other.id, name: other.name };
    });
}

/**
 * A table that may be wider than a phone scrolls in its own box, which a keyboard can reach and
 * a screen reader names, rather than widening the page.
 * @param {string} id @param {string} inner @param {string} label
 */
export const scroller = (id, inner, label) => `<div class="scroller" id="${id}" role="region" aria-label="${escapeHtml(label)}" tabindex="0">${inner}</div>`;

/**
 * One reading: a figure over what it counts, set like an instrument's dial. The label may lead
 * to where the figure is told in full. @param {string} value @param {string} label @param {string} [href]
 */
export const reading = (value, label, href) =>
  `<div class="reading"><dt>${href ? `<a href="${href}">${escapeHtml(label)}</a>` : escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;

/**
 * A step's name and what it says. The model writes each step as "Name: what happens"; a step
 * written without a name is called by its number. @param {{ n: number, text: string }} st
 */
export function stepWords(st) {
  const [head, ...rest] = st.text.split(": ");
  const said = rest.length ? rest.join(": ") : st.text;
  return { name: rest.length ? head : `Step ${st.n}`, text: said.charAt(0).toUpperCase() + said.slice(1) };
}

/** A rate as a whole percent, or to one place where rounding would say all or none when it was not (99.9% up). */
export const percent = (/** @type {number | null} */ rate) => {
  if (rate === null) return "not enough data yet";
  const whole = Math.round(rate * 100);
  return (whole === 100 && rate < 1) || (whole === 0 && rate > 0) ? `${(Math.floor(rate * 1000) / 10).toFixed(1)}%` : `${whole}%`;
};
export const minutes = (/** @type {number | null} */ m) => (m === null ? "not enough data yet" : m < 120 ? `${m} minutes` : `${Math.round(m / 60)} hours`);

/** A system's lines to other systems, grouped by what they say, for its page. @param {any} model @param {string} id */
function connectionGroups(model, id) {
  /** @type {Map<string, Array<{ id: string, name: string }>>} */
  const groups = new Map();
  for (const c of connectionsOf(model, id)) groups.set(c.verb, [...(groups.get(c.verb) ?? []), { id: c.id, name: c.name }]);
  return groups;
}

/**
 * One system and the systems it connects to, drawn by dagre at build: a wire for each
 * relationship between any two of them, the chosen one marked. Hidden from assistive
 * technology, since the list beside it says the same.
 * @param {any} model @param {string} id
 */
function neighbourhood(model, id) {
  const byId = new Map(model.systems.map((/** @type {any} */ s) => [s.id, s]));
  const near = new Set([id]);
  for (const r of model.relationships) {
    if (!byId.has(r.from) || !byId.has(r.to) || r.from === r.to) continue;
    if (r.from === id) near.add(r.to);
    if (r.to === id) near.add(r.from);
  }
  // A hub's neighbors stand in one long column that says no more than the list above it.
  if (near.size < 2 || near.size > 11) return "";
  return graphSvg({
    id: `near-${id}`,
    title: `${byId.get(id).name} and the ${near.size - 1} ${near.size === 2 ? "system" : "systems"} it connects to`,
    boxes: [...near].map((x) => ({ id: x, label: byId.get(x).name, href: systemPath(x), lines: [], sub: RING_NAMES[/** @type {keyof typeof RING_NAMES} */ (byId.get(x).ring)], current: x === id })),
    // Only its own lines: the lines among its neighbors belong on their pages, and drawn here
    // they turned a hub's page into a tangle.
    wires: model.relationships.filter((/** @type {any} */ r) => (r.from === id || r.to === id) && near.has(r.from) && near.has(r.to)).map((/** @type {any} */ r) => ({ from: r.from, to: r.to })),
  });
}

/**
 * @param {any} model @param {string} id @param {string} asOf @param {any[]} [maps] its code maps, if it has any
 * @param {any} [home] the system whose code pages hold its repo, when it shares one
 */
export function systemPage(model, id, asOf, maps = [], home = undefined) {
  const s = model.systems.find((/** @type {any} */ x) => x.id === id);
  if (!s) throw new Error(`no system ${id}`);
  const groups = connectionGroups(model, id);
  const parts = model.containers.filter((/** @type {any} */ c) => c.system === id);
  const own = ownParts(parts);
  const repos = !s.private && !s.hide_repo_link ? (s.repos ?? []) : [];
  const facts = [
    ["Ring", RING_NAMES[/** @type {keyof typeof RING_NAMES} */ (s.ring)]],
    ["Kind", s.family],
    ...(s.domain ? [["Address", `<a href="https://${escapeHtml(s.domain)}">${escapeHtml(s.domain)}</a>`]] : []),
    ...(repos.length ? [["Source", repos.map((/** @type {string} */ r) => `<a href="${escapeHtml(r)}">${escapeHtml(r.replace(/^https:\/\/github\.com\//, "")).replace("/", "/<wbr>")}</a>`).join("<br>")]] : []),
    ["Visibility", s.private ? "Private" : "Public"],
    ...(own.length ? [["Parts", `<a href="${containersPath(id)}">${own.length}</a>`]] : []),
    ["Connections", String([...groups.values()].reduce((n, g) => n + g.length, 0))],
    ...(maps.length ? [["Code", `<a href="${codePath(id)}">${escapeHtml(codeSummary(maps))}</a>`]] : home ? [["Code", `<a href="${codePath(home.id)}">Measured with ${escapeHtml(home.name)}, which shares its repo</a>`]] : []),
    ["Write-up", `<a href="${sitePath(id)}">${escapeHtml(s.name)} on dustinedwards.info</a>`],
  ];
  const lead = s.description ? escapeHtml(s.description) : s.private ? "Private: its repo is not public." : "";
  // Every system's page opens zoomed into its circle; Back to all systems is the family.
  const drawing = `<div class="map-host">${familyMap(model, { id: "family", label: "The family", headingLevel: 3, openLabel: "Its page" }, undefined, id)}</div>`;
  const body = `${pageHead([["/", "Overview"], ["/systems/", "Systems"]], s.name, escapeHtml(s.name), lead)}
<dl class="readings readings-facts">${facts.map(([k, v]) => `<div class="reading"><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>
<section aria-labelledby="inside-title"><h2 id="inside-title">${own.length ? `Inside ${escapeHtml(s.name)}` : "In the family"}</h2>
${own.length ? `<p class="section-sub">Its ${own.length} parts: ${own.map((/** @type {any} */ c) => `<a href="${partPath(c)}">${escapeHtml(c.name)}</a>`).join(", ")}. <a href="${containersPath(id)}">Inside ${escapeHtml(s.name)}: its ${own.length} parts and how they connect</a>.</p>` : ""}
${drawing}</section>
<section aria-labelledby="links-title"><h2 id="links-title">Connections</h2>
${groups.size ? `<div class="links-grid"><dl class="links">${[...groups].map(([verb, list]) => `<div><dt>${escapeHtml(verb)}</dt><dd>${list.map((c) => `<a href="${systemPath(c.id)}">${escapeHtml(c.name)}</a>`).join(", ")}</dd></div>`).join("")}</dl>${neighbourhood(model, id)}</div>` : "<p>None drawn.</p>"}
</section>
${flowLinks(model, id)}
${maps.length ? riskiest(id, maps) : ""}`;
  return layout({
    title: s.name,
    description: s.description ?? (s.private ? `${s.name} is private.` : s.name),
    path: systemPath(id),
    body,
    asOf,
  });
}

/**
 * A system's own parts, inside its boundary; its `external` containers (Agents, GitHub) are
 * what it works with outside it (Dustin, 2026-10-11: external boxes, outside the boundary).
 * @param {any[]} parts
 */
const ownParts = (parts) => parts.filter((c) => c.kind !== "external");

/** @param {any} model @param {string} id @param {string} asOf */
export function containersPage(model, id, asOf) {
  const s = model.systems.find((/** @type {any} */ x) => x.id === id);
  const parts = model.containers.filter((/** @type {any} */ c) => c.system === id);
  if (!s || parts.length === 0) throw new Error(`no containers page for ${id}`);
  const own = ownParts(parts);
  const outside = parts.filter((/** @type {any} */ c) => c.kind === "external");
  const byId = new Map(parts.map((/** @type {any} */ c) => [c.id, c]));
  const wires = model.relationships.filter((/** @type {any} */ r) => byId.has(r.from) && byId.has(r.to));
  const map = familyMap(model, { id: "family", label: `Inside ${s.name}`, headingLevel: 3, openLabel: "Its page" }, undefined, id);
  const body = `${pageHead([["/", "Overview"], ["/systems/", "Systems"], [systemPath(id), s.name]], "Inside", `Inside ${escapeHtml(s.name)}`, `Its ${own.length} parts, what each runs on, and how they connect${outside.length ? `, plus ${outside.length === 1 ? "the one outside system" : `the ${outside.length} outside systems`} it works with` : ""}.`)}
<section class="step-drawing" aria-labelledby="drawing-title"><h2 id="drawing-title" class="cap-sr-only">The drawing</h2><div class="map-host">${map}</div></section>
${scroller("parts", `<table class="cap-table"><caption>The parts of ${escapeHtml(s.name)}</caption>
<thead><tr><th scope="col">Part</th><th scope="col">Kind</th><th scope="col">Runs on</th><th scope="col">What it does</th></tr></thead>
<tbody>${own.map((/** @type {any} */ c) => `<tr id="part-${escapeHtml(c.id)}"><th scope="row">${escapeHtml(c.name)}</th><td>${escapeHtml(c.kind)}</td><td>${escapeHtml(c.technology)}</td><td data-wrap>${escapeHtml(c.description ?? "")}</td></tr>`).join("")}</tbody></table>`, `The parts of ${s.name}`)}
${outside.length ? `<section aria-labelledby="outside-title"><h2 id="outside-title">Outside it</h2>
<ul>${outside.map((/** @type {any} */ c) => `<li id="part-${escapeHtml(c.id)}"><strong>${escapeHtml(c.name)}</strong> (${escapeHtml(c.technology)})${c.description ? `: ${escapeHtml(c.description)}` : ""}</li>`).join("")}</ul>
</section>` : ""}
<section aria-labelledby="wires-title"><h2 id="wires-title">How they connect</h2>
${wires.length ? `<ul class="wires">${wires.map((/** @type {any} */ r) => `<li>${escapeHtml(byId.get(r.from).name)} <span class="verb">${escapeHtml(VERB[/** @type {keyof typeof VERB} */ (r.kind)]?.[0] ?? r.kind)}</span> ${escapeHtml(byId.get(r.to).name)}</li>`).join("")}</ul>` : "<p>None drawn.</p>"}
</section>
${flowLinks(model, id)}`;
  return layout({ title: `Inside ${s.name}`, description: `The parts of ${s.name} and how they connect.`, path: containersPath(id), parent: [systemPath(id), s.name], body, asOf });
}

/** The page of every system: the capsid drawing, and a table to sort and filter. @param {any} model @param {Map<string, any[]>} bySystem @param {string} asOf */
export function systemsPage(model, bySystem, asOf) {
  const map = familyMap(model, {
    id: "family",
    label: "Drawn as a capsid",
    caption: "A capsid is the protein shell of a virus, built from repeated parts called capsomers. This family is built the same way: Capsid in the middle, the shared parts around it, what people use on the outside.",
    headingLevel: 2,
    openLabel: "Its page",
  });
  const count = (/** @type {string} */ id) => connectionsOf(model, id).length;
  const modules = (/** @type {string} */ id) => (bySystem.get(id) ?? []).reduce((n, m) => n + m.modules.length, 0);
  const rows = model.systems
    .map(
      (/** @type {any} */ s) => `<tr data-item data-kinds="${escapeHtml(s.ring)}${s.private ? " private" : ""}" data-text="${escapeHtml(`${s.name} ${s.domain ?? ""} ${s.family} ${s.description ?? ""}`.toLowerCase())}"><th scope="row"><a href="${systemPath(s.id)}">${escapeHtml(s.name)}</a></th><td>${escapeHtml(RING_NAMES[/** @type {keyof typeof RING_NAMES} */ (s.ring)])}</td><td>${escapeHtml(s.family)}</td><td>${s.domain ? escapeHtml(s.domain) : ""}</td><td data-sort="${ownParts(model.containers.filter((/** @type {any} */ c) => c.system === s.id)).length}">${ownParts(model.containers.filter((/** @type {any} */ c) => c.system === s.id)).length}</td><td data-sort="${count(s.id)}">${count(s.id)}</td><td data-sort="${modules(s.id)}">${modules(s.id) || ""}</td><td>${s.private ? "Private" : "Public"}</td></tr>`
    )
    .join("");
  const chips = [["all", "All"], ["core", "Runs everything"], ["shared", "Shared parts"], ["used", "What people use"], ["private", "Private"]];
  const privates = model.systems.filter((/** @type {any} */ s) => s.private).length;
  const body = `${pageHead([["/", "Overview"]], "Systems", "The family of systems", `The ${model.systems.length} systems this Capsid server runs and how they connect, with Capsid in the middle. Pick a system to see its connections, or open its page.${privates ? ` ${privates} are private.` : ""}`)}
<section aria-labelledby="family-title">${map}</section>
<section aria-labelledby="table-title"><h2 id="table-title">Every system</h2>
<div class="filter-bar" data-filter="systems" hidden>
<label class="cap-sr-only" for="sys-q">Filter the systems</label>
<input class="cap-input" id="sys-q" type="search" placeholder="Filter by name, address or kind" autocomplete="off" data-filter-q>
<div class="chips" role="group" aria-label="Show">${chips.map(([k, label], i) => `<button type="button" class="cap-btn" data-size="sm" data-chip="${k}" aria-pressed="${i ? "false" : "true"}">${label}</button>`).join("")}</div>
<p class="hint" role="status" data-filter-count></p>
</div>
${scroller("systems-table", `<table class="cap-table" data-sortable><caption>Every system, with its parts, connections and measured modules</caption>
<thead><tr><th scope="col">System</th><th scope="col">Ring</th><th scope="col">Kind</th><th scope="col">Address</th><th scope="col">Parts</th><th scope="col">Connections</th><th scope="col">Modules</th><th scope="col">Visibility</th></tr></thead>
<tbody>${rows}</tbody></table>`, "Every system")}
<p class="hint" data-filter-empty hidden>No system matches that.</p>
</section>`;
  return layout({ title: "Systems", description: `The ${model.systems.length} systems this Capsid server runs and how they connect.`, path: "/systems/", body, asOf });
}

/**
 * @typedef {{ id: string, system: string, name: string }} Part
 * @typedef {{ n: number, from: Part, to: Part, toward: string, kind: string, text: string, lights: Part[], touches: Part[] }} Step
 * @typedef {{ id: string, name: string, description?: string, steps: Step[] }} Flow
 */

/**
 * A flow's steps read against the model: each step's edge, its two ends and the parts it lights.
 * Every system, part, line and flow is public (src/system-model.ts, toPublic; a private system
 * only lacks its repo link), so the build stops only for a line the map does not have or a part
 * it does not hold (design section 4, "Animated flows").
 * @param {any} model @param {any} flow
 * @returns {Flow}
 */
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
    if (!edge) throw new Error(`${where} rides ${st.relationship}, which is not a relationship in the public model`);
    if (st.toward !== edge.from && st.toward !== edge.to) throw new Error(`${where} goes toward ${st.toward}, which is not an end of ${edge.id}`);
    const from = part(edge.from);
    const to = part(edge.to);
    const lights = (st.lights ?? []).map(part);
    const touches = [from, to, ...lights].filter((p, k, all) => all.findIndex((q) => q.id === p.id) === k);
    return { n: i + 1, from, to, toward: st.toward, kind: edge.kind, text: st.text, lights, touches };
  });
  return { id: flow.id, name: flow.name, description: flow.description, steps };
}

/** Every flow in the model, resolved. @param {any} model @returns {Flow[]} */
export const flowsOf = (model) => (model.flows ?? []).map((/** @type {any} */ f) => resolveFlow(model, f));

/** The flows whose steps touch a part of one system, as a section, or nothing. @param {any} model @param {string} id */
function flowLinks(model, id) {
  const flows = flowsOf(model).filter((f) => f.steps.some((st) => st.touches.some((p) => p.system === id)));
  if (!flows.length) return "";
  return `<section aria-labelledby="flows-title"><h2 id="flows-title">Step by step</h2>
<ul>${flows.map((f) => `<li><a href="${flowPath(f.id)}">${escapeHtml(f.name)}</a>, in ${f.steps.length} steps${f.description ? `: ${escapeHtml(f.description)}` : ""}</li>`).join("")}</ul>
</section>`;
}

/** What a part is to a step, in words. @param {Step} st @param {Part} p */
function role(st, p) {
  const end = p.id === st.from.id || p.id === st.to.id;
  if (end && p.id === st.toward) return "step arrives";
  if (end) return "step starts";
  return "also used";
}

/** The step list, each step a link, the one shown marked. @param {Flow} f @param {number} [current] */
function stepList(f, current) {
  return `<ol class="flow-steps" data-swap="steps">${f.steps
    .map((st) => {
      const w = stepWords(st);
      return `<li><a href="${stepPath(f.id, st.n)}" data-go="${st.n}"${st.n === current ? ' aria-current="step"' : ""}><span class="step-name">${escapeHtml(w.name)}</span> ${escapeHtml(w.text)}</a></li>`;
    })
    .join("")}</ol>`;
}

/**
 * Capsomer's map entered, with one step's line on and its parts lit, as the markup the script
 * would leave, so the page draws the step with no script (Capsomer's contract,
 * components/system-map: data-entered on the root, data-on on a wire, data-lit and data-at on
 * a box). Throws when the markup it marks is not there, so a change in Capsomer fails the build.
 * @param {string} html @param {Step} st
 */
export function markStep(html, st) {
  const root = '<figure class="cap-system-map" data-cap="system-map"';
  if (!html.includes(root)) throw new Error("the map's root is not where the flow page marks it");
  let on = 0;
  const marked = html
    .replace(root, html.includes(" data-entered") ? root : `${root} data-entered`)
    .replace(/<path class="cap-system-map-wire" data-from="([^"]*)" data-to="([^"]*)"/g, (m, from, to) => {
      const hit = (from === st.from.id && to === st.to.id) || (from === st.to.id && to === st.from.id);
      if (hit) on++;
      return hit ? `${m} data-on` : m;
    })
    .replace(/<g class="cap-system-map-box" data-id="([^"]*)"/g, (m, id) => `${m}${st.lights.some((p) => p.id === id) ? " data-lit" : ""}${id === st.toward ? " data-at" : ""}`);
  if (on !== 1) throw new Error(`step ${st.n} rides ${st.from.id} to ${st.to.id}, which the drawing has ${on} lines for`);
  return marked;
}

/**
 * The flows the map can play, in its words: those whose every step stays inside the core.
 * @param {any} model @param {Flow[]} flows
 */
function mapFlows(model, flows) {
  const core = model.systems.find((/** @type {any} */ s) => s.ring === "core");
  return flows
    .filter((f) => !!core && f.steps.every((x) => x.touches.every((p) => p.system === core.id)))
    .map((f) => ({ id: f.id, name: f.name, steps: f.steps.map((x) => ({ from: x.from.id, to: x.to.id, toward: x.toward, text: x.text, lights: x.lights.map((p) => p.id) })) }));
}

/** A flow's own page: what it is, the core drawn playing it, and every step. @param {any} model @param {Flow} f @param {string} asOf */
export function flowPage(model, f, asOf) {
  const stage = flowStage(model, [f], f, "flow-map");
  const no = `${sectionAt("/flows/")?.no}.${flowsOf(model).findIndex((x) => x.id === f.id) + 1}`;
  const body = `<div class="patched">${pageHead([["/", "Overview"], ["/flows/", "Flows"]], f.name, escapeHtml(f.name), escapeHtml(f.description ?? `${f.steps.length} steps.`))}${patch(f, no)}</div>
${stage ? `<div class="flow-stage" data-ui>${stage}</div>` : ""}
<section aria-labelledby="steps-title"><h2 id="steps-title">Every step</h2>${bands(f)}</section>
<p><a class="cap-btn" data-variant="primary" href="${stepPath(f.id, 1)}">Step through it, one page a step</a></p>`;
  return layout({ title: f.name, description: f.description ?? f.name, path: flowPath(f.id), body, asOf });
}

/**
 * A flow's steps as numbered bands, each its name, what happens and the parts it touches, leading
 * to its step's page; brief, the names alone, for the list of every flow, whose own pages tell the rest.
 * @param {Flow} f @param {boolean} [brief]
 */
export const bands = (f, brief = false) =>
  `<ol class="bands${brief ? " bands-brief" : ""}">${f.steps
    .map((st) => {
      const w = stepWords(st);
      return brief
        ? `<li><a href="${stepPath(f.id, st.n)}"><span class="band-name">${escapeHtml(w.name)}</span></a></li>`
        : `<li><a href="${stepPath(f.id, st.n)}"><span class="band-text"><span class="band-name">${escapeHtml(w.name)}</span>${escapeHtml(w.text)}</span><span class="band-parts">${st.touches.map((p) => `<span class="part-name">${escapeHtml(p.name)}</span>`).join("")}</span></a></li>`;
    })
    .join("")}</ol>`;

/**
 * The core drawn with a flow on it and a Play button that steps it in place, with no change of
 * address (src/explorer.js, player). Empty when the flow leaves the core, which the map cannot draw.
 * @param {any} model @param {Flow[]} flows every flow the drawing can switch to @param {Flow} shown @param {string} id
 * @param {boolean} [play] whether a Play button follows it (the tour steps it by scrolling instead)
 */
export function flowStage(model, flows, shown, id, play = true) {
  const core = model.systems.find((/** @type {any} */ s) => s.ring === "core");
  if (!mapFlows(model, [shown]).length) return "";
  const data = { ...mapData(model), flows: mapFlows(model, flows) };
  const map = markStep(familyMap(model, { id, label: `Inside ${core.name}`, headingLevel: 2 }, data, core.id), shown.steps[0]);
  const host = `<div class="map-host flow-map" data-flow="${escapeHtml(shown.id)}" data-step="1" data-steps="${shown.steps.length}" data-player>${map}</div>`;
  if (!play) return host;
  return `${host}
<p class="hero-play"><button class="cap-btn" type="button" data-autoplay hidden>Play</button><span class="hint">${escapeHtml(shown.name)}, in ${shown.steps.length} steps, over ${escapeHtml(core.name)}'s real parts.</span></p>`;
}

/** Every flow, with what it touches and its first steps. @param {any} model @param {string} asOf */
export function flowsIndexPage(model, asOf) {
  const flows = flowsOf(model);
  const names = new Map(model.systems.map((/** @type {any} */ s) => [s.id, s.name]));
  const body = `${pageHead([["/", "Overview"]], "Flows", "What runs, step by step", `${flows.length} processes Capsid runs, each shown step by step on the parts it uses. Open one to watch it run.`)}
<ul class="flow-cards">${flows
    .map((f, i) => {
      const systems = [...new Set(f.steps.flatMap((st) => st.touches.map((p) => p.system)))];
      const parts = [...new Set(f.steps.flatMap((st) => st.touches.map((p) => p.name)))];
      return `<li class="flow-card" data-livery>${patch(f, `${sectionAt("/flows/")?.no}.${i + 1}`)}<h2><a href="${flowPath(f.id)}">${escapeHtml(f.name)}</a></h2>
<p>${escapeHtml(f.description ?? "")}</p>
<p class="hint">${f.steps.length} steps over ${parts.length} parts of ${systems.map((x) => escapeHtml(String(names.get(x) ?? x))).join(", ")}.</p>
${bands(f, true)}
<p><a class="cap-btn" data-variant="primary" href="${flowPath(f.id)}">Watch it run</a></p></li>`;
    })
    .join("")}</ul>`;
  return layout({ title: "Flows", description: "Each process Capsid runs, shown step by step on the parts it uses.", path: "/flows/", body, asOf });
}

/**
 * One step's heading, sentence and parts. The shown step is read; every other step is laid in the
 * same grid cell, unseen and out of the accessibility tree, so the section is as tall as the
 * longest step at any width and stepping never moves the drawing below it (design section 6,
 * CLS). The unseen copies carry no id and no link. Each is set as an Apollo cue card: a dark strip
 * naming the flow and the card, the roll blocks under it, short lines in capitals, and a box to
 * tick beside each part with a dotted leader to what it is to the step.
 * @param {Step} st @param {number} total @param {Map<string, any>} systems @param {boolean} shown @param {string} name the flow's
 */
function stepText(st, total, systems, shown, name) {
  const link = (/** @type {string} */ href, /** @type {string} */ text, cls = "") =>
    shown ? `<a${cls ? ` class="${cls}"` : ""} href="${href}">${text}</a>` : `<span${cls ? ` class="${cls}"` : ""}>${text}</span>`;
  const parts = st.touches
    .map((p) => `<li${shown ? ` data-part="${escapeHtml(p.id)}"` : ""}>${link(partPath(p), escapeHtml(p.name), "cap-cue-name")}<span class="cap-cue-value touch-role">${role(st, p)}</span><span class="touch-in">in ${link(systemPath(p.system), escapeHtml(systems.get(p.system)?.name ?? p.system))}</span></li>`)
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

/**
 * One step of a flow: where it is, what happens, the parts it touches, Back and Next, and the
 * core drawn with the step's line on. The script (src/explorer.js) steps without a reload and
 * moves a token along the line; with no script every step is a page of its own.
 * @param {any} model @param {Flow} f @param {number} n @param {string} asOf
 */
export function stepPage(model, f, n, asOf) {
  const st = f.steps[n - 1];
  if (!st) throw new Error(`flow ${f.id} has no step ${n}`);
  const total = f.steps.length;
  const systems = new Map(model.systems.map((/** @type {any} */ s) => [s.id, s]));
  // Flows play over the core's circle, so a flow over another system's parts has its text and
  // its parts but no drawing.
  const core = model.systems.find((/** @type {any} */ s) => s.ring === "core");
  const drawn = mapFlows(model, [f]).length > 0;
  const map = drawn ? markStep(familyMap(model, { id: "family", label: `Inside ${core.name}`, headingLevel: 3 }, { ...mapData(model), flows: mapFlows(model, [f]) }, core.id), st) : "";
  const nav = [
    n > 1 ? `<a rel="prev" href="${stepPath(f.id, n - 1)}" data-go="${n - 1}" class="cap-sign">Back<span class="cap-sr-only">: step ${n - 1}</span></a>` : "",
    n < total ? `<a rel="next" href="${stepPath(f.id, n + 1)}" data-go="${n + 1}" class="cap-sign">Next<span class="cap-sr-only">: step ${n + 1}</span></a>` : "",
  ].join("");
  // Play steps through on its own; the script shows it, since without script there is nothing to play.
  const play = drawn ? `<button class="cap-btn" type="button" data-autoplay hidden>Play</button>` : "";
  const body = `${pageHead([["/", "Overview"], ["/flows/", "Flows"], [flowPath(f.id), f.name]], `Step ${n}`, escapeHtml(f.name))}
<div class="step-layout${drawn ? " step-layout-drawn" : ""}">
<section class="flow-step" data-swap="step" aria-labelledby="step-title">
<div class="flow-stack">${f.steps.map((x) => stepText(x, total, systems, x.n === n, f.name)).join("")}</div>
<nav class="flow-nav" aria-label="Steps">${nav}${play}</nav>
</section>
${drawn ? `<section class="step-drawing" aria-labelledby="drawing-title"><h2 id="drawing-title" class="cap-sr-only">The drawing</h2><div class="map-host flow-map" data-flow="${escapeHtml(f.id)}" data-step="${n}" data-steps="${total}">${map}</div><p class="hint" data-keys hidden>Number keys 1 to ${Math.min(total, 9)} go to that step.</p></section>` : ""}
</div>
<section aria-labelledby="steps-title"><h2 id="steps-title">Every step</h2>${stepList(f, n)}</section>`;
  return layout({
    title: `${f.name}, step ${n} of ${total}`,
    parent: [flowPath(f.id), f.name],
    description: st.text,
    path: stepPath(f.id, n),
    body,
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

/**
 * Every page the explorer serves, as [path, html]: the front page, one per system, one per
 * public system with parts, one per flow and one per step of it, the code pages of each public
 * system with a code map, and the 404.
 * @param {any} model @param {any} stats @param {any} [code] the public code document
 * @param {any[]} [tools] the served tools (src/surface.mjs)
 * @returns {Array<[string, string]>}
 */
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
  // Every system with parts has a parts page, a private one included.
  for (const s of model.systems) {
    pages.push([systemPath(s.id), systemPage(model, s.id, asOf, bySystem.get(s.id), codeHome(model, bySystem, s.id))]);
    if (model.containers.some((/** @type {any} */ c) => c.system === s.id)) pages.push([containersPath(s.id), containersPage(model, s.id, asOf)]);
  }
  for (const f of flowsOf(model)) {
    pages.push([flowPath(f.id), flowPage(model, f, asOf)]);
    for (const st of f.steps) pages.push([stepPath(f.id, st.n), stepPage(model, f, st.n, asOf)]);
  }
  pages.push(...toolPages(tools, asOf));
  pages.push(...codePages(model, bySystem, asOf));
  pages.push(["/404", notFoundPage(asOf)]);
  return pages;
}

/** The search index: every page worth finding, as the search page's script reads it. @param {any} model @param {any} code @param {any[]} tools */
export const searchDocument = (model, code, tools) => searchIndex(model, codeBySystem(model, code), flowsOf(model), tools);
