// The explorer's pages, as HTML strings from the public model and numbers
// (capsid/research/design-system-explorer.md, section 4; slice 5 of its build order).
// Pure: no file, network or clock. build.mjs writes what these return; the tests read them.
//
// Every address is a prerendered page with its content in the HTML. A private system has a
// page that says it is private, so no link to one 404s. Every system page links to the same
// system on dustinedwards.info, and that site's pages link back (section 4, "Deep links both
// ways"). Times of day never appear: the documents carry a date and nothing finer.
import { systemMapHtml } from "capsomer/behaviour/system-map";
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
 * The page around a body: one stylesheet set, one module script, no inline script or style,
 * so the policy in _headers needs no hash (src/security-headers.mjs). A wide page's sections
 * set their own width, for the front page's full-bleed parts; any other page is one column.
 * @param {{ title: string, description: string, path: string, body: string, asOf: string, wide?: boolean }} page
 */
export function layout({ title, description, path, body, asOf, wide = false }) {
  const here = sectionOf(path);
  const nav = NAV.map(([href, label]) => `<a href="${href}"${href === here ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${ORIGIN}${path}">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/capsomer.css">
<link rel="stylesheet" href="/assets/enarratio.css">
<link rel="stylesheet" href="/assets/explorer.css">
<script type="module" src="/assets/explorer.js"></script>
</head>
<body>
<a class="skip" href="#main">Skip to the content</a>
<header class="top">
<a class="home" href="/"><img src="/assets/icon.svg" alt="" width="28" height="28">Capsid</a>
<nav class="top-nav" aria-label="Sections">${nav}</nav>
<a class="top-search" href="/search/"${path === "/search/" ? ' aria-current="page"' : ""} data-search-open>Search<kbd aria-hidden="true">/</kbd></a>
</header>
<main id="main" tabindex="-1"${wide ? ' class="wide"' : ""}>
${body}
</main>
${footer(asOf)}
</body>
</html>
`;
}

/** The close of every page: what the site is, where to go, the day of its data, and the source. @param {string} asOf */
function footer(asOf) {
  return `<footer class="foot">
<div class="foot-tile foot-about"><p>Capsid runs Dustin Edwards's projects and the AI sessions that work on them. This site is built once a day from its public model and numbers.</p><p class="foot-small">Private systems show what their owner has made public, and never a repo. MIT licensed.</p></div>
<nav class="foot-tile foot-nav" aria-label="Every section"><ul>${[...NAV, ["/search/", "Search"]].map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join("")}</ul></nav>
<div class="foot-tile foot-day"><p>Data of</p><p class="foot-big">${escapeHtml(asOf)}</p><p class="foot-small">Whole days, ending at midnight UTC.</p></div>
<div class="foot-tile foot-out"><p><a href="${SITE}/systems">The family on dustinedwards.info</a></p><p><a href="https://portal.dustinedwards.info">The Portal</a>, for the owners</p></div>
<p class="foot-tile foot-mark" aria-hidden="true">Capsid</p>
<a class="foot-tile foot-cta" href="https://github.com/DrDustinEdwards/capsid">Read the source<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" focusable="false"><path d="M10 38 38 10M16 10h22v22" fill="none" stroke="currentColor" stroke-width="4"/></svg></a>
</footer>`;
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

/** The map's data, each system linking to its explorer page. */
export function mapData(/** @type {any} */ model) {
  return {
    systems: model.systems.map((/** @type {any} */ s) => ({
      id: s.id,
      name: s.name,
      short: s.short,
      ring: s.ring,
      private: s.private,
      tag: s.ring === "core" ? undefined : s.ring === "shared" ? "shared" : s.family,
      description: s.description,
      domain: s.domain || undefined,
      href: systemPath(s.id),
    })),
    relationships: model.relationships.map((/** @type {any} */ r) => ({ from: r.from, to: r.to, kind: r.kind })),
    containers: model.containers.map((/** @type {any} */ c) => ({ id: c.id, system: c.system, name: c.name, kind: c.kind })),
  };
}

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
  if (near.size < 2) return "";
  return graphSvg({
    id: `near-${id}`,
    title: `${byId.get(id).name} and the ${near.size - 1} ${near.size === 2 ? "system" : "systems"} it connects to`,
    boxes: [...near].map((x) => ({ id: x, label: byId.get(x).name, href: systemPath(x), lines: [], sub: RING_NAMES[/** @type {keyof typeof RING_NAMES} */ (byId.get(x).ring)], current: x === id })),
    wires: model.relationships.filter((/** @type {any} */ r) => near.has(r.from) && near.has(r.to)).map((/** @type {any} */ r) => ({ from: r.from, to: r.to })),
  });
}

/**
 * A system's own parts and the lines between them, drawn by dagre: Capsomer's map draws only
 * the core's insides, so every other system's parts are drawn this way.
 * @param {any} model @param {any} s
 */
function partsDrawing(model, s) {
  const parts = model.containers.filter((/** @type {any} */ c) => c.system === s.id);
  if (parts.length < 2) return "";
  const ids = new Set(parts.map((/** @type {any} */ c) => c.id));
  return graphSvg({
    id: `parts-${s.id}`,
    title: `The parts of ${s.name} and the lines between them`,
    boxes: parts.map((/** @type {any} */ c) => ({ id: c.id, label: c.name, href: partPath(c), lines: [], sub: c.technology })),
    wires: model.relationships.filter((/** @type {any} */ r) => ids.has(r.from) && ids.has(r.to)).map((/** @type {any} */ r) => ({ from: r.from, to: r.to })),
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
  ];
  const lead = s.description ? escapeHtml(s.description) : s.private ? (s.domain ? "Private: its name and address only." : "Private: its name only.") : "";
  const map = systemMapHtml(mapData(model), { id: "family", label: "The family", headingLevel: 3, openLabel: "Its page" });
  const drawing = s.ring === "core" ? "" : partsDrawing(model, s);
  const body = `${pageHead([["/", "Overview"], ["/systems/", "Systems"]], s.name, escapeHtml(s.name), lead)}
<div class="system-top">
<dl class="facts">${facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join("")}</dl>
<p class="out"><a class="arrow" href="${sitePath(id)}">${escapeHtml(s.name)} on dustinedwards.info</a></p>
</div>
${own.length ? `<section aria-labelledby="inside-title"><h2 id="inside-title">Inside ${escapeHtml(s.name)}</h2>
<p class="section-sub">Its ${own.length} parts: ${own.map((/** @type {any} */ c) => `<a href="${partPath(c)}">${escapeHtml(c.name)}</a>`).join(", ")}. <a href="${containersPath(id)}">Inside ${escapeHtml(s.name)}: its ${own.length} parts and how they connect</a>.</p>
${drawing}</section>` : ""}
<section aria-labelledby="links-title"><h2 id="links-title">Connections</h2>
${groups.size ? `<div class="links-grid"><dl class="links">${[...groups].map(([verb, list]) => `<div><dt>${escapeHtml(verb)}</dt><dd>${list.map((c) => `<a href="${systemPath(c.id)}">${escapeHtml(c.name)}</a>`).join(", ")}</dd></div>`).join("")}</dl>${neighbourhood(model, id)}</div>` : "<p>None drawn.</p>"}
</section>
${flowLinks(model, id)}
${maps.length ? riskiest(id, maps) : ""}
<section aria-labelledby="family-title"><h2 id="family-title">In the family</h2><div class="map-host" data-chosen="${escapeHtml(id)}">${map}</div></section>`;
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
  // Capsomer's map draws the core's insides only; every other system's parts are drawn by dagre.
  const core = s.ring === "core";
  const map = core ? systemMapHtml(mapData(model), { id: "family", label: `Inside ${s.name}`, headingLevel: 3 }) : "";
  const body = `${pageHead([["/", "Overview"], ["/systems/", "Systems"], [systemPath(id), s.name]], "Inside", `Inside ${escapeHtml(s.name)}`, `Its ${own.length} parts, what each runs on, and the lines between them: the containers of the C4 model, inside the system's boundary${outside.length ? `, and the ${outside.length} it works with outside it` : ""}.`)}
${core ? `<section aria-labelledby="drawing-title"><h2 id="drawing-title">The drawing</h2><div class="map-host" data-chosen="${escapeHtml(id)}" data-enter>${map}</div></section>` : partsDrawing(model, s)}
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
  const map = systemMapHtml(mapData(model), {
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
  const body = `${pageHead([["/", "Overview"]], "Systems", "The family of systems", `The ${model.systems.length} systems Dustin Edwards runs, how they connect, and what Capsid, the one in the middle, is made of. Choose a system to draw its connections, or open its page.${privates ? ` ${privates} are private.` : ""}`)}
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
 * A flow's steps read against the model: each step's edge, its two ends and the parts it lights,
 * as parts of public systems. The public document only ever holds whole public flows
 * (src/system-model.ts, toPublic), so anything else here is a document the filter did not write,
 * and the build stops rather than draw a line the map does not have or name a private part
 * (design section 4, "Animated flows"; docs/public-data.md, rule 5).
 * @param {any} model @param {any} flow
 * @returns {Flow}
 */
export function resolveFlow(model, flow) {
  const edges = new Map(model.relationships.map((/** @type {any} */ r) => [r.id, r]));
  const parts = new Map(model.containers.map((/** @type {any} */ c) => [c.id, c]));
  const systems = new Map(model.systems.map((/** @type {any} */ s) => [s.id, s]));
  const steps = flow.steps.map((/** @type {any} */ st, /** @type {number} */ i) => {
    const where = `flow ${flow.id} step ${i + 1}`;
    /** @param {string} id @returns {Part} */
    const part = (id) => {
      const c = parts.get(id);
      if (!c) {
        const s = systems.get(id);
        throw new Error(s?.private ? `${where} touches ${id}, a private system` : `${where} touches ${id}, which is not a part in the public model`);
      }
      if (systems.get(c.system)?.private !== false) throw new Error(`${where} touches ${id}, a part of ${c.system}, which is not public`);
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
  if (end && p.id === st.toward) return "the step moves toward it";
  if (end) return "the step moves from it";
  return "lit by the step";
}

/** The step list, each step a link, the one shown marked. @param {Flow} f @param {number} [current] */
function stepList(f, current) {
  return `<ol class="flow-steps" data-swap="steps">${f.steps
    .map((st) => `<li><a href="${stepPath(f.id, st.n)}" data-go="${st.n}"${st.n === current ? ' aria-current="step"' : ""}>${escapeHtml(st.text)}</a></li>`)
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
    .replace(root, `${root} data-entered`)
    .replace(/<path class="cap-system-map-wire" data-from="([^"]*)" data-to="([^"]*)"/g, (m, from, to) => {
      const hit = (from === st.from.id && to === st.to.id) || (from === st.to.id && to === st.from.id);
      if (hit) on++;
      return hit ? `${m} data-on` : m;
    })
    .replace(/<g class="cap-system-map-box" data-id="([^"]*)"/g, (m, id) => `${m}${st.lights.some((p) => p.id === id) ? " data-lit" : ""}${id === st.toward ? " data-at" : ""}`);
  if (on !== 1) throw new Error(`step ${st.n} rides ${st.from.id} to ${st.to.id}, which the drawing has ${on} lines for`);
  return marked;
}

/** A flow's own page: what it is and every step. @param {Flow} f @param {string} asOf */
export function flowPage(f, asOf) {
  const body = `${pageHead([["/", "Overview"], ["/flows/", "Flows"]], f.name, escapeHtml(f.name), escapeHtml(f.description ?? `${f.steps.length} steps.`))}
<p><a class="cap-btn" data-variant="primary" href="${stepPath(f.id, 1)}">Start at step 1 of ${f.steps.length}</a></p>
<section aria-labelledby="steps-title"><h2 id="steps-title">Every step</h2>${stepList(f)}</section>`;
  return layout({ title: `${f.name}, Capsid`, description: f.description ?? f.name, path: flowPath(f.id), body, asOf });
}

/** Every flow, with what it touches and its first steps. @param {any} model @param {string} asOf */
export function flowsIndexPage(model, asOf) {
  const flows = flowsOf(model);
  const names = new Map(model.systems.map((/** @type {any} */ s) => [s.id, s.name]));
  const body = `${pageHead([["/", "Overview"]], "Flows", "What runs, step by step", `${flows.length} walks over the model, each step riding a line the map really has. Play one to see its token travel Capsid's parts.`)}
<ul class="flow-cards">${flows
    .map((f) => {
      const systems = [...new Set(f.steps.flatMap((st) => st.touches.map((p) => p.system)))];
      const parts = [...new Set(f.steps.flatMap((st) => st.touches.map((p) => p.name)))];
      return `<li class="flow-card"><h2><a href="${flowPath(f.id)}">${escapeHtml(f.name)}</a></h2>
<p>${escapeHtml(f.description ?? "")}</p>
<p class="hint">${f.steps.length} steps over ${parts.length} parts of ${systems.map((x) => escapeHtml(String(names.get(x) ?? x))).join(", ")}.</p>
<ol class="bands">${f.steps.map((st) => `<li><a href="${stepPath(f.id, st.n)}"><span class="band-text">${escapeHtml(st.text)}</span><span class="band-parts">${st.touches.map((p) => escapeHtml(p.name)).join(", ")}</span></a></li>`).join("")}</ol>
<p><a class="cap-btn" data-variant="primary" href="${stepPath(f.id, 1)}">Play it</a></p></li>`;
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
    .map((p) => `<li${shown ? ` data-part="${escapeHtml(p.id)}"` : ""}>${link(partPath(p), escapeHtml(p.name))}, in ${link(systemPath(p.system), escapeHtml(systems.get(p.system)?.name ?? p.system))}: ${role(st, p)}</li>`)
    .join("");
  return `<div${shown ? "" : ' class="flow-unseen" aria-hidden="true" inert'}>
<h2${shown ? ' id="step-title"' : ""}>Step ${st.n} of ${total}</h2>
<p class="flow-text">${escapeHtml(st.text)}</p>
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
  // Capsomer draws only the core's insides, so a flow over another system's parts has its text
  // and its parts but no drawing, as that system's parts page does.
  const core = model.systems.find((/** @type {any} */ s) => s.ring === "core");
  const drawn = !!core && f.steps.every((x) => x.touches.every((p) => p.system === core.id));
  let map = "";
  if (drawn) {
    const flow = { id: f.id, name: f.name, steps: f.steps.map((x) => ({ from: x.from.id, to: x.to.id, toward: x.toward, text: x.text, lights: x.lights.map((p) => p.id) })) };
    map = markStep(systemMapHtml({ ...mapData(model), flows: [flow] }, { id: "family", label: `Inside ${core.name}`, headingLevel: 3 }), st);
  }
  const nav = [
    n > 1 ? `<a rel="prev" href="${stepPath(f.id, n - 1)}" data-go="${n - 1}">Back<span class="cap-sr-only">: step ${n - 1}</span></a>` : "",
    n < total ? `<a rel="next" href="${stepPath(f.id, n + 1)}" data-go="${n + 1}">Next<span class="cap-sr-only">: step ${n + 1}</span></a>` : "",
  ].join("");
  // Play steps through on its own; the script shows it, since without script there is nothing to play.
  const play = drawn ? `<button class="cap-btn" type="button" data-autoplay hidden>Play</button>` : "";
  const body = `${pageHead([["/", "Overview"], ["/flows/", "Flows"], [flowPath(f.id), f.name]], `Step ${n}`, escapeHtml(f.name))}
<section class="flow-step" data-swap="step" aria-labelledby="step-title">
<div class="flow-stack">${f.steps.map((x) => stepText(x, total, systems, x.n === n)).join("")}</div>
<nav class="flow-nav" aria-label="Steps">${nav}${play}</nav>
</section>
${drawn ? `<section aria-labelledby="drawing-title"><h2 id="drawing-title">The drawing</h2><p class="hint" data-keys hidden>Number keys 1 to ${Math.min(total, 9)} go to that step.</p><div class="map-host flow-map" data-flow="${escapeHtml(f.id)}" data-step="${n}" data-steps="${total}">${map}</div></section>` : ""}
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
  // A system's parts are published only when the privacy filter let them through, so a private
  // system has a parts page exactly when the public model gives it parts.
  for (const s of model.systems) {
    pages.push([systemPath(s.id), systemPage(model, s.id, asOf, bySystem.get(s.id))]);
    if (model.containers.some((/** @type {any} */ c) => c.system === s.id)) pages.push([containersPath(s.id), containersPage(model, s.id, asOf)]);
  }
  for (const f of flowsOf(model)) {
    pages.push([flowPath(f.id), flowPage(f, asOf)]);
    for (const st of f.steps) pages.push([stepPath(f.id, st.n), stepPage(model, f, st.n, asOf)]);
  }
  pages.push(...toolPages(tools, asOf));
  pages.push(...codePages(model, bySystem, sourceOf, asOf));
  pages.push(["/404", notFoundPage(asOf)]);
  return pages;
}

/** The search index: every page worth finding, as the search page's script reads it. @param {any} model @param {any} code @param {any[]} tools */
export const searchDocument = (model, code, tools) => searchIndex(model, codeBySystem(model, code), flowsOf(model), tools);
