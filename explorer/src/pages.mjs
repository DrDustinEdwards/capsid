// The explorer's pages, as HTML strings from the public model and numbers
// (capsid/research/design-system-explorer.md, section 4; slice 5 of its build order).
// Pure: no file, network or clock. build.mjs writes what these return; the tests read them.
//
// Every address is a prerendered page with its content in the HTML. A private system has a
// page that says it is private, so no link to one 404s. Every system page links to the same
// system on dustinedwards.info, and that site's pages link back (section 4, "Deep links both
// ways"). Times of day never appear: the documents carry a date and nothing finer.
import { modelMapData, systemMapHtml } from "capsomer/behaviour/system-map";
import { circleLayers } from "capsomer/system-map-circles";
import { escapeHtml } from "@dustinedwards/site-runtime/html";

import { codeBySystem, codeIndexPage, codePages, codePath, codeSummary, codeTotals, riskiest } from "./code.mjs";
import { graphSvg } from "./graph.mjs";
import { homePage } from "./home.mjs";
import { numbersPage } from "./numbers.mjs";
import { searchIndex, searchPage } from "./search.mjs";
import { toolPages } from "./tools.mjs";

export const SITE = "https://dustinedwards.info";
const ORIGIN = "https://capsid.dustinedwards.info";

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

/** The section a path belongs to, for the bar's aria-current. @param {string} path */
function sectionOf(path) {
  if (path === "/") return "/";
  if (/^\/s\/[^/]+\/code\//.test(path)) return "/code/";
  if (path.startsWith("/s/")) return "/systems/";
  return NAV.find(([href]) => href !== "/" && path.startsWith(href))?.[0] ?? "";
}

/**
 * The page around a body: one stylesheet set, the theme script and one module script, no inline
 * script or style, so the policy in _headers needs no hash (src/security-headers.mjs). A wide page's sections
 * set their own width, for the front page's full-bleed parts; any other page is one column.
 * @param {{ title: string, description: string, path: string, body: string, asOf: string, wide?: boolean }} page
 */
export function layout({ title, description, path, body, asOf, wide = false }) {
  const here = sectionOf(path);
  return `<!doctype html>
<html lang="en" data-cap-site="capsid" data-family="purple">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${ORIGIN}${path}">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="preload" href="/assets/schibsted.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/capsomer.css">
<link rel="stylesheet" href="/assets/enarratio.css">
<link rel="stylesheet" href="/assets/explorer.css">
<script src="/assets/theme.js"></script>
<script type="module" src="/assets/explorer.js"></script>
</head>
<body>
${header(here, path)}
<main id="main" tabindex="-1"${wide ? ' class="wide"' : ""}>
${body}
</main>
${footer(asOf)}
</body>
</html>
`;
}

/** A 24-box glyph for the header, drawn by Capsomer's stroke. @param {string} body */
const glyph = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;

/** A header control's tip: its name and its key. @param {string} text @param {string} key */
const tip = (text, key) =>
  `<span class="cap-site-header-tip cap-popover" data-variant="tooltip" data-side="bottom" data-offset="6" popover="manual" role="tooltip" aria-hidden="true"><span class="cap-site-header-tip-text">${text}</span><span class="cap-keys"><kbd>${key}</kbd></span></span>`;

/**
 * Capsomer's site header, written by hand (components/site-header): the logo, the sections,
 * search, the theme button and, on a phone, the menu and its sheet. The theme button's name is
 * the light page's; theme.js names it for the theme showing before it paints.
 * @param {string} here the current section @param {string} path
 */
function header(here, path) {
  const link = (/** @type {string} */ href, /** @type {string} */ label, /** @type {string} */ cls) => `<a${cls ? ` class="${cls}"` : ""} href="${href}"${href === here || href === path ? ' aria-current="page"' : ""}>${cls ? label : `<span class="cap-site-header-sheet-name">${label}</span>`}</a>`;
  return `<header class="cap-site-header" data-cap="site-header" data-links="left">
<a class="cap-site-header-skip" href="#main">Skip to the content</a>
<a class="cap-site-header-logo" href="/" aria-label="Capsid"><img src="/assets/icon.svg" alt="" width="24" height="24"><span aria-hidden="true">Capsid</span></a>
<nav class="cap-site-header-sections" aria-label="Site"><ul>${NAV.map(([href, label]) => `<li>${link(href, label, "cap-site-header-link")}</li>`).join("")}</ul></nav>
<div class="cap-site-header-tools">
<div class="cap-site-header-extras"><a class="cap-site-header-icon" href="/search/" aria-label="Search"${path === "/search/" ? ' aria-current="page"' : ""}>${glyph('<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>')}${tip("Search", "/")}</a></div>
<button type="button" class="cap-theme-button cap-site-header-icon cap-site-header-theme" data-cap="theme-switch" data-variant="button" aria-label="Switch to dark theme"><svg class="cap-theme-icon" data-show="light" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg><svg class="cap-theme-icon" data-show="dark" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg><span class="cap-theme-tip cap-popover" data-variant="tooltip" data-side="bottom" data-offset="6" popover="manual" role="tooltip" aria-hidden="true"><span class="cap-theme-tip-text">Switch to dark theme</span><span class="cap-keys"><kbd>T</kbd></span></span></button>
<button type="button" class="cap-site-header-icon cap-site-header-menu" aria-label="Menu" aria-haspopup="dialog" aria-expanded="false" aria-controls="site-sheet">${glyph('<path d="M4 7h16M4 12h16M4 17h16"/>')}</button>
</div>
<dialog class="cap-dialog cap-site-header-sheet" data-cap="dialog" data-placement="bottom" id="site-sheet" aria-labelledby="site-sheet-title">
<div class="cap-dialog-header"><h2 id="site-sheet-title" class="cap-dialog-title cap-site-header-sheet-title" tabindex="-1">Capsid menu</h2></div>
<div class="cap-dialog-body"><nav aria-labelledby="site-sheet-title"><div class="cap-site-header-sheet-label">Pages</div><ul class="cap-site-header-sheet-list">${[...NAV, ["/search/", "Search"]].map(([href, label]) => `<li>${link(href, label, "")}</li>`).join("")}</ul></nav></div>
<button type="button" class="cap-btn cap-dialog-close" data-variant="quiet" data-icon-only data-cap-part="close" aria-label="Close"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
</dialog>
</header>`;
}

/** The close of every page: what the site is, where to go, the day of its data, and the source. @param {string} asOf */
function footer(asOf) {
  return `<footer class="foot">
<p class="mark" aria-hidden="true">${[..."Capsid"].map((c) => `<span>${c}</span>`).join("")}</p>
<div class="foot-in wrap">
<div class="foot-about"><p>Capsid is an MCP server and control plane for AI coding agents, published under the MIT licence. This site is one live instance, rebuilt each day from its public model and numbers.</p><p class="foot-small">Data of ${escapeHtml(asOf)}, in whole days ending at midnight UTC. Private systems are drawn in full, with no link to their repo.</p></div>
<nav class="foot-nav" aria-label="Every section"><ul>${[...NAV, ["/search/", "Search"]].map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join("")}</ul></nav>
<ul class="foot-out"><li><a href="https://github.com/DrDustinEdwards/capsid">The source</a>, MIT licensed</li><li><a href="https://github.com/DrDustinEdwards/capsid#installation">Run your own</a></li><li><a href="${SITE}/systems">The family on dustinedwards.info</a></li><li><a href="https://portal.dustinedwards.info">The Portal</a>, for the owners</li></ul>
</div></footer>`;
}

/**
 * A page's heading block: the trail to it, its title and its lead sentence.
 * @param {Array<[string, string]>} trail earlier pages as [href, name] @param {string} here @param {string} title @param {string} [lead] html
 */
export function pageHead(trail, here, title, lead) {
  const crumbs = trail.length
    ? `<nav class="crumbs" aria-label="Breadcrumb">${trail.map(([href, name]) => `<a href="${href}">${escapeHtml(name)}</a> / `).join("")}<span aria-current="page">${escapeHtml(here)}</span></nav>`
    : "";
  return `${crumbs}<h1>${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ""}`;
}

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
 * @param {any} model @param {import("capsomer/behaviour/system-map").SystemMapOptions} options @param {any} [data] @param {string} [chosen]
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

export const percent = (/** @type {number | null} */ rate) => (rate === null ? "not enough data yet" : `${Math.round(rate * 100)}%`);
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
  // A hub's neighbours stand in one long column that says no more than the list above it.
  if (near.size < 2 || near.size > 11) return "";
  return graphSvg({
    id: `near-${id}`,
    title: `${byId.get(id).name} and the ${near.size - 1} ${near.size === 2 ? "system" : "systems"} it connects to`,
    boxes: [...near].map((x) => ({ id: x, label: byId.get(x).name, href: systemPath(x), lines: [], sub: RING_NAMES[/** @type {keyof typeof RING_NAMES} */ (byId.get(x).ring)], current: x === id })),
    // Only its own lines: the lines among its neighbours belong on their pages, and drawn here
    // they turned a hub's page into a tangle.
    wires: model.relationships.filter((/** @type {any} */ r) => (r.from === id || r.to === id) && near.has(r.from) && near.has(r.to)).map((/** @type {any} */ r) => ({ from: r.from, to: r.to })),
  });
}

/** @param {any} model @param {string} id @param {string} asOf @param {any[]} [maps] its code maps, if it has any */
export function systemPage(model, id, asOf, maps = []) {
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
    ...(repos.length ? [["Source", repos.map((/** @type {string} */ r) => `<a href="${escapeHtml(r)}">${escapeHtml(r.replace(/^https:\/\//, ""))}</a>`).join("<br>")]] : []),
    ["Visibility", s.private ? "Private" : "Public"],
    ...(own.length ? [["Parts", `<a href="${containersPath(id)}">${own.length}</a>`]] : []),
    ["Connections", String([...groups.values()].reduce((n, g) => n + g.length, 0))],
    ...(maps.length ? [["Code", `<a href="${codePath(id)}">${escapeHtml(codeSummary(maps))}</a>`]] : []),
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
    title: `${s.name}, Capsid`,
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
  const body = `${pageHead([["/", "Overview"], ["/systems/", "Systems"], [systemPath(id), s.name]], "Inside", `Inside ${escapeHtml(s.name)}`, `Its ${own.length} parts, what each runs on, and the lines between them: the containers of the C4 model, inside the system's boundary${outside.length ? `, and the ${outside.length} it works with outside it` : ""}.`)}
<section class="step-drawing" aria-labelledby="drawing-title"><h2 id="drawing-title" class="cap-sr-only">The drawing</h2><div class="map-host">${map}</div></section>
${scroller("parts", `<table class="cap-table"><caption>The parts of ${escapeHtml(s.name)}</caption>
<thead><tr><th scope="col">Part</th><th scope="col">Kind</th><th scope="col">Runs on</th><th scope="col">What it does</th></tr></thead>
<tbody>${own.map((/** @type {any} */ c) => `<tr id="part-${escapeHtml(c.id)}"><th scope="row">${escapeHtml(c.name)}</th><td>${escapeHtml(c.kind)}</td><td>${escapeHtml(c.technology)}</td><td>${escapeHtml(c.description ?? "")}</td></tr>`).join("")}</tbody></table>`, `The parts of ${s.name}`)}
${outside.length ? `<section aria-labelledby="outside-title"><h2 id="outside-title">Outside it</h2>
<ul>${outside.map((/** @type {any} */ c) => `<li id="part-${escapeHtml(c.id)}"><strong>${escapeHtml(c.name)}</strong> (${escapeHtml(c.technology)})${c.description ? `: ${escapeHtml(c.description)}` : ""}</li>`).join("")}</ul>
</section>` : ""}
<section aria-labelledby="wires-title"><h2 id="wires-title">How they connect</h2>
${wires.length ? `<ul class="wires">${wires.map((/** @type {any} */ r) => `<li>${escapeHtml(byId.get(r.from).name)} <span class="verb">${escapeHtml(VERB[/** @type {keyof typeof VERB} */ (r.kind)]?.[0] ?? r.kind)}</span> ${escapeHtml(byId.get(r.to).name)}</li>`).join("")}</ul>` : "<p>None drawn.</p>"}
</section>
${flowLinks(model, id)}`;
  return layout({ title: `Inside ${s.name}, Capsid`, description: `The parts of ${s.name} and how they connect.`, path: containersPath(id), body, asOf });
}

/** The page of every system: the capsid drawing, and a table to sort and filter. @param {any} model @param {Map<string, any[]>} bySystem @param {string} asOf */
export function systemsPage(model, bySystem, asOf) {
  const map = familyMap(model, {
    id: "family",
    label: "The family of systems",
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
  const body = `${pageHead([["/", "Overview"]], "Systems", "The family of systems", `The ${model.systems.length} systems Dustin Edwards runs, how they connect, and what Capsid, the one in the middle, is made of. Choose a system to see its wiring, or open its page.${privates ? ` ${privates} are private.` : ""}`)}
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
  return layout({ title: "Systems, Capsid", description: `The ${model.systems.length} systems Dustin Edwards runs, as a capsid, and how they connect.`, path: "/systems/", body, asOf });
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
  if (end && p.id === st.toward) return "where the step arrives";
  if (end) return "where the step starts";
  return "also used in the step";
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
  const body = `${pageHead([["/", "Overview"], ["/flows/", "Flows"]], f.name, escapeHtml(f.name), escapeHtml(f.description ?? `${f.steps.length} steps.`))}
${stage ? `<div class="flow-stage" data-ui>${stage}</div>` : ""}
<section aria-labelledby="steps-title"><h2 id="steps-title">Every step</h2>${bands(f)}</section>
<p><a class="cap-btn" data-variant="primary" href="${stepPath(f.id, 1)}">Step through it, one page a step</a></p>`;
  return layout({ title: `${f.name}, Capsid`, description: f.description ?? f.name, path: flowPath(f.id), body, asOf });
}

/** A flow's steps as numbered bands, each its name, what happens and the parts it touches, leading to its step's page. @param {Flow} f */
export const bands = (f) =>
  `<ol class="bands">${f.steps
    .map((st) => {
      const w = stepWords(st);
      return `<li><a href="${stepPath(f.id, st.n)}"><span class="band-text"><span class="band-name">${escapeHtml(w.name)}</span>${escapeHtml(w.text)}</span><span class="band-parts">${st.touches.map((p) => `<span class="part-name">${escapeHtml(p.name)}</span>`).join("")}</span></a></li>`;
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
  const body = `${pageHead([["/", "Overview"]], "Flows", "What runs, step by step", `The ${flows.length} things Capsid does that are worth watching, each told step by step over the parts it really touches. Open one to watch it run.`)}
<ul class="flow-cards">${flows
    .map((f) => {
      const systems = [...new Set(f.steps.flatMap((st) => st.touches.map((p) => p.system)))];
      const parts = [...new Set(f.steps.flatMap((st) => st.touches.map((p) => p.name)))];
      return `<li class="flow-card"><h2><a href="${flowPath(f.id)}">${escapeHtml(f.name)}</a></h2>
<p>${escapeHtml(f.description ?? "")}</p>
<p class="hint">${f.steps.length} steps over ${parts.length} parts of ${systems.map((x) => escapeHtml(String(names.get(x) ?? x))).join(", ")}.</p>
${bands(f)}
<p><a class="cap-btn" data-variant="primary" href="${flowPath(f.id)}">Watch it run</a></p></li>`;
    })
    .join("")}</ul>`;
  return layout({ title: "Flows, Capsid", description: "What Capsid runs, step by step: a job's life, the nightly backup and a Carrel publish.", path: "/flows/", body, asOf });
}

/**
 * One step's heading, sentence and parts. The shown step is read; every other step is laid in the
 * same grid cell, unseen and out of the accessibility tree, so the section is as tall as the
 * longest step at any width and stepping never moves the drawing below it (design section 6,
 * CLS). The unseen copies carry no id and no link.
 * @param {Step} st @param {number} total @param {Map<string, any>} systems @param {boolean} shown
 */
function stepText(st, total, systems, shown) {
  const link = (/** @type {string} */ href, /** @type {string} */ text) => (shown ? `<a href="${href}">${text}</a>` : `<span>${text}</span>`);
  const parts = st.touches
    .map((p) => `<li${shown ? ` data-part="${escapeHtml(p.id)}"` : ""}>${link(partPath(p), escapeHtml(p.name))}<span class="touch-role">${role(st, p)}, in ${link(systemPath(p.system), escapeHtml(systems.get(p.system)?.name ?? p.system))}</span></li>`)
    .join("");
  return `<div${shown ? "" : ' class="flow-unseen" aria-hidden="true" inert'}>
<h2${shown ? ' id="step-title"' : ""}>Step ${st.n} of ${total}</h2>
<p class="step-head">${escapeHtml(stepWords(st).name)}</p>
<p class="flow-text">${escapeHtml(stepWords(st).text)}</p>
<h3>What it touches</h3>
<ul class="flow-touches">${parts}</ul>
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
    n > 1 ? `<a rel="prev" href="${stepPath(f.id, n - 1)}" data-go="${n - 1}">Back<span class="cap-sr-only">: step ${n - 1}</span></a>` : "",
    n < total ? `<a rel="next" href="${stepPath(f.id, n + 1)}" data-go="${n + 1}">Next<span class="cap-sr-only">: step ${n + 1}</span></a>` : "",
  ].join("");
  // Play steps through on its own; the script shows it, since without script there is nothing to play.
  const play = drawn ? `<button class="cap-btn" type="button" data-autoplay hidden>Play</button>` : "";
  const body = `${pageHead([["/", "Overview"], ["/flows/", "Flows"], [flowPath(f.id), f.name]], `Step ${n}`, escapeHtml(f.name))}
<div class="step-layout${drawn ? " step-layout-drawn" : ""}">
<section class="flow-step" data-swap="step" aria-labelledby="step-title">
<div class="flow-stack">${f.steps.map((x) => stepText(x, total, systems, x.n === n)).join("")}</div>
<nav class="flow-nav" aria-label="Steps">${nav}${play}</nav>
</section>
${drawn ? `<section class="step-drawing" aria-labelledby="drawing-title"><h2 id="drawing-title" class="cap-sr-only">The drawing</h2><p class="hint" data-keys hidden>Number keys 1 to ${Math.min(total, 9)} go to that step.</p><div class="map-host flow-map" data-flow="${escapeHtml(f.id)}" data-step="${n}" data-steps="${total}">${map}</div></section>` : ""}
</div>
<section aria-labelledby="steps-title"><h2 id="steps-title">Every step</h2>${stepList(f, n)}</section>`;
  return layout({
    title: `${f.name}, step ${n} of ${total}, Capsid`,
    description: st.text,
    path: stepPath(f.id, n),
    body,
    asOf,
  });
}

/** @param {string} asOf */
export function notFoundPage(asOf) {
  return layout({
    title: "Not found, Capsid",
    description: "No page here.",
    path: "/404",
    body: `<h1>Nothing here</h1><p class="lead">There is no page at this address. <a href="/systems/">Every system</a> is listed, and <a href="/search/">search</a> finds the rest.</p>`,
    asOf,
  });
}

/**
 * Every page the explorer serves, as [path, html]: the front page, one per system, one per
 * public system with parts, one per flow and one per step of it, the code pages of each public
 * system with a code map, and the 404.
 * @param {any} model @param {any} stats @param {any} [code] the public code document
 * @param {(repo: string, path: string) => string | undefined} [sourceOf] a module's source at its map's commit
 * @param {any[]} [tools] the served tools (src/surface.mjs)
 * @returns {Array<[string, string]>}
 */
export function allPages(model, stats, code = null, sourceOf = () => undefined, tools = []) {
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
    pages.push([systemPath(s.id), systemPage(model, s.id, asOf, bySystem.get(s.id))]);
    if (model.containers.some((/** @type {any} */ c) => c.system === s.id)) pages.push([containersPath(s.id), containersPage(model, s.id, asOf)]);
  }
  for (const f of flowsOf(model)) {
    pages.push([flowPath(f.id), flowPage(model, f, asOf)]);
    for (const st of f.steps) pages.push([stepPath(f.id, st.n), stepPage(model, f, st.n, asOf)]);
  }
  pages.push(...toolPages(tools, asOf));
  pages.push(...codePages(model, bySystem, sourceOf, asOf));
  pages.push(["/404", notFoundPage(asOf)]);
  return pages;
}

/** The search index: every page worth finding, as the search page's script reads it. @param {any} model @param {any} code @param {any[]} tools */
export const searchDocument = (model, code, tools) => searchIndex(model, codeBySystem(model, code), flowsOf(model), tools);
