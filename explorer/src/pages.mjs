// The explorer's pages, as HTML strings from the public model and numbers
// (capsid/research/design-system-explorer.md, section 4; slice 5 of its build order).
// Pure: no file, network or clock. build.mjs writes what these return; the tests read them.
//
// Every address is a prerendered page with its content in the HTML. A private system has a
// page that says it is private, so no link to one 404s. Every system page links to the same
// system on dustinedwards.info, and that site's pages link back (section 4, "Deep links both
// ways"). Times of day never appear: the documents carry a date and nothing finer.
import { systemMapHtml } from "capsomer/behaviour/system-map";
import { barChart, progressRing } from "enarratio";
import { escapeHtml } from "@dustinedwards/site-runtime/html";

import { codeBySystem, codePages, codePath, codeSummary } from "./code.mjs";

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

/**
 * The page around a body: one stylesheet set, one module script, no inline script or style,
 * so the policy in _headers needs no hash (src/security-headers.mjs).
 * @param {{ title: string, description: string, path: string, body: string, asOf: string, script?: boolean }} page
 */
export function layout({ title, description, path, body, asOf, script = false }) {
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
${script ? '<script type="module" src="/assets/explorer.js"></script>\n' : ""}</head>
<body>
<a class="skip" href="#main">Skip to the content</a>
<header class="top"><a class="home" href="/">Capsid explorer</a><a href="${SITE}/systems">The family on dustinedwards.info</a></header>
<main id="main" tabindex="-1">
${body}
</main>
<footer class="foot"><p>From Capsid's public model and numbers of ${escapeHtml(asOf)}. Private systems show a name and an address only.</p></footer>
</body>
</html>
`;
}

/** The map's data, each system linking to its explorer page. */
function mapData(/** @type {any} */ model) {
  return {
    systems: model.systems.map((/** @type {any} */ s) => ({
      id: s.id,
      name: s.name,
      short: s.short,
      ring: s.ring,
      private: s.private,
      tag: s.ring === "core" ? undefined : s.ring === "shared" ? "shared" : s.family,
      description: s.private ? undefined : s.description,
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
const scroller = (id, inner, label) => `<div class="scroller" id="${id}" role="region" aria-label="${escapeHtml(label)}" tabindex="0">${inner}</div>`;

const percent = (/** @type {number | null} */ rate) => (rate === null ? "not enough data yet" : `${Math.round(rate * 100)}%`);
const minutes = (/** @type {number | null} */ m) => (m === null ? "not enough data yet" : m < 120 ? `${m} minutes` : `${Math.round(m / 60)} hours`);

/**
 * The daily numbers: each a sentence, a picture and the table behind it (section 4).
 * @param {any} stats
 */
export function numbersHtml(stats) {
  // Each week by its last whole day. as_of is the window's end, the midnight that starts it
  // (src/public-stats.ts), so the last week ends the day before; each before it seven days earlier.
  const end = new Date(Date.parse(`${stats.as_of}T00:00:00Z`) - 86_400_000);
  const weeks = stats.jobs.completed_by_week.map((/** @type {number} */ count, /** @type {number} */ i, /** @type {number[]} */ all) => {
    const day = new Date(end.getTime() - (all.length - 1 - i) * 7 * 86_400_000);
    return { week: day.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }), jobs: count };
  });
  const total = stats.jobs.completed_by_week.reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0);
  const perWeek = barChart({
    id: "jobs-per-week",
    data: weeks,
    x: "week",
    y: "jobs",
    title: "Jobs completed per week",
    xLabel: "week ending",
    // Under Enarratio's 480 the drawing scales to a phone's width instead of scrolling inside
    // a frame no keyboard can reach (axe, scrollable-region-focusable, on the phone project).
    width: 440,
    alt: `Jobs completed in each of the last eight whole weeks, oldest first: ${weeks.map((/** @type {any} */ w) => w.jobs).join(", ")}; ${total} in all.`,
  });
  /** A ring, its heading and its sentence: Enarratio's ring is a primitive, so the figure is ours. */
  const ring = (/** @type {string} */ id, /** @type {string} */ title, /** @type {number} */ rate, /** @type {string} */ sentence) =>
    `<figure class="ring" aria-labelledby="${id}-title"><h3 id="${id}-title">${escapeHtml(title)}</h3>${progressRing({ value: rate, max: 1, size: 112, alt: sentence })}<figcaption>${escapeHtml(sentence)}</figcaption></figure>`;
  const rings = [];
  if (stats.verification.agreement_rate_90d !== null) {
    rings.push(ring("agreement", "Verification agreement", stats.verification.agreement_rate_90d, `In the last 90 days, ${percent(stats.verification.agreement_rate_90d)} of ${stats.verification.evaluations_90d} checked claims agreed with what GitHub records.`));
  }
  if (stats.sites.uptime_7d !== null) {
    rings.push(ring("uptime", "Uptime, last 7 days", stats.sites.uptime_7d, `The ${stats.sites.watched} watched sites answered in ${percent(stats.sites.uptime_7d)} of ${stats.sites.slots_measured_7d} measured half-hours over the last seven days.`));
  }
  const rows = [
    ["Jobs completed, last 7 days", stats.jobs.completed_7d],
    ["Jobs completed, last 30 days", stats.jobs.completed_30d],
    ["Jobs failed, last 30 days", stats.jobs.failed_30d],
    ["Jobs open today", stats.jobs.open],
    ["Jobs blocked today", stats.jobs.blocked],
    ["Median time a job takes, last 30 days", minutes(stats.jobs.median_duration_minutes_30d)],
    ["Pull requests merged, of those claimed, last 90 days", percent(stats.verification.pr_merge_rate_90d)],
    ["CI green when claimed, last 90 days", percent(stats.verification.ci_green_rate_90d)],
    ["Approval waits, last 30 days", stats.gates.waits_30d],
    ["Median approval wait, last 30 days", minutes(stats.gates.median_wait_minutes_30d)],
    ["Documents in the store", stats.store.documents],
  ];
  return `<section class="numbers" aria-labelledby="numbers-title">
<h2 id="numbers-title">The daily numbers</h2>
<p class="lead">Counts and rates across every project and agent, over whole days ending at midnight UTC on ${escapeHtml(stats.as_of)}. A rate over fewer than ten cases is left out.</p>
<div class="charts">${perWeek}${rings.join("")}</div>
${scroller("numbers-table", `<table class="cap-table numbers-table"><caption>Every number, as of ${escapeHtml(stats.as_of)}</caption><tbody>
${rows.map(([label, value]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join("\n")}
</tbody></table>`, "Every number")}
</section>`;
}

/** @param {any} model @param {any} stats */
export function homePage(model, stats) {
  const privates = model.systems.filter((/** @type {any} */ s) => s.private).length;
  const map = systemMapHtml(mapData(model), {
    id: "family",
    label: "The family of systems",
    caption: "A capsid is the protein shell of a virus, built from repeated parts called capsomers. This family is built the same way: Capsid in the middle, the shared parts around it, what people use on the outside.",
    headingLevel: 3,
    openLabel: "Its page",
  });
  const body = `<h1>Capsid, inside and out</h1>
<p class="lead">The ${model.systems.length} systems Dustin Edwards runs, how they connect, and what Capsid, the one in the middle, is made of. Choose a system to see its connections, or open its page. ${privates} are private and show a name and an address only.</p>
<section aria-labelledby="family-title"><h2 id="family-title">The family</h2>${map}</section>
${numbersHtml(stats)}`;
  return layout({ title: "Capsid explorer", description: `The ${model.systems.length} systems Dustin Edwards runs, as a capsid, with Capsid's daily numbers.`, path: "/", body, asOf: stats.as_of, script: true });
}

/** @param {any} model @param {string} id @param {string} asOf @param {any[]} [maps] its code maps, if it has any */
export function systemPage(model, id, asOf, maps = []) {
  const s = model.systems.find((/** @type {any} */ x) => x.id === id);
  if (!s) throw new Error(`no system ${id}`);
  const links = connectionsOf(model, id);
  const parts = model.containers.filter((/** @type {any} */ c) => c.system === id);
  const facts = [
    ["Ring", RING_NAMES[/** @type {keyof typeof RING_NAMES} */ (s.ring)]],
    ...(s.domain ? [["Address", `<a href="https://${escapeHtml(s.domain)}">${escapeHtml(s.domain)}</a>`]] : []),
    ...(!s.private && s.repos?.[0] ? [["Source", `<a href="${escapeHtml(s.repos[0])}">${escapeHtml(s.repos[0].replace(/^https:\/\//, ""))}</a>`]] : []),
  ];
  const map = systemMapHtml(mapData(model), { id: "family", label: "The family", headingLevel: 3, openLabel: "Its page" });
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Capsid explorer</a> / <span aria-current="page">${escapeHtml(s.name)}</span></nav>
<h1>${escapeHtml(s.name)}</h1>
<p class="lead">${s.private ? (s.domain ? "Private: its name and address only." : "Private: its name only.") : escapeHtml(s.description ?? "")}</p>
<dl class="facts">${facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join("")}</dl>
<p class="out"><a href="${sitePath(id)}">${escapeHtml(s.name)} on dustinedwards.info</a></p>
${parts.length ? `<p><a href="${containersPath(id)}">Inside ${escapeHtml(s.name)}: its ${ownParts(parts).length} parts and how they connect</a></p>` : ""}
${maps.length ? `<p><a href="${codePath(id)}">Its code: ${escapeHtml(codeSummary(maps))}</a></p>` : ""}
<section aria-labelledby="links-title"><h2 id="links-title">Connections</h2>
${links.length ? `<ul>${links.map((c) => `<li>${escapeHtml(c.verb)} <a href="${systemPath(c.id)}">${escapeHtml(c.name)}</a></li>`).join("")}</ul>` : "<p>None drawn.</p>"}
</section>
${s.private ? "" : flowLinks(model, id)}
<section aria-labelledby="family-title"><h2 id="family-title">In the family</h2><div class="map-host" data-chosen="${escapeHtml(id)}">${map}</div></section>`;
  return layout({
    title: `${s.name}, in the Capsid explorer`,
    description: s.private ? `${s.name} is private.` : (s.description ?? s.name),
    path: systemPath(id),
    body,
    asOf,
    script: true,
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
  if (!s || s.private || parts.length === 0) throw new Error(`no containers page for ${id}`);
  const own = ownParts(parts);
  const outside = parts.filter((/** @type {any} */ c) => c.kind === "external");
  const byId = new Map(parts.map((/** @type {any} */ c) => [c.id, c]));
  const wires = model.relationships.filter((/** @type {any} */ r) => byId.has(r.from) && byId.has(r.to));
  // Capsomer's map draws the core's insides only, so another system's parts are the table and
  // the list, with no drawing that would show the core's.
  const drawn = s.ring === "core";
  const map = drawn ? systemMapHtml(mapData(model), { id: "family", label: `Inside ${s.name}`, headingLevel: 3 }) : "";
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Capsid explorer</a> / <a href="${systemPath(id)}">${escapeHtml(s.name)}</a> / <span aria-current="page">Inside</span></nav>
<h1>Inside ${escapeHtml(s.name)}</h1>
<p class="lead">Its ${own.length} parts, what each runs on, and the lines between them: the containers of the C4 model, inside the system's boundary${outside.length ? `, and the ${outside.length} it works with outside it` : ""}.</p>
${scroller("parts", `<table class="cap-table"><caption>The parts of ${escapeHtml(s.name)}</caption>
<thead><tr><th scope="col">Part</th><th scope="col">Kind</th><th scope="col">Runs on</th><th scope="col">What it does</th></tr></thead>
<tbody>${own.map((/** @type {any} */ c) => `<tr id="part-${escapeHtml(c.id)}"><th scope="row">${escapeHtml(c.name)}</th><td>${escapeHtml(c.kind)}</td><td>${escapeHtml(c.technology)}</td><td>${escapeHtml(c.description ?? "")}</td></tr>`).join("")}</tbody></table>`, `The parts of ${s.name}`)}
${outside.length ? `<section aria-labelledby="outside-title"><h2 id="outside-title">Outside it</h2>
<ul>${outside.map((/** @type {any} */ c) => `<li id="part-${escapeHtml(c.id)}"><strong>${escapeHtml(c.name)}</strong> (${escapeHtml(c.technology)})${c.description ? `: ${escapeHtml(c.description)}` : ""}</li>`).join("")}</ul>
</section>` : ""}
<section aria-labelledby="wires-title"><h2 id="wires-title">How they connect</h2>
${wires.length ? `<ul>${wires.map((/** @type {any} */ r) => `<li>${escapeHtml(byId.get(r.from).name)} ${escapeHtml(VERB[/** @type {keyof typeof VERB} */ (r.kind)]?.[0] ?? r.kind)} ${escapeHtml(byId.get(r.to).name)}</li>`).join("")}</ul>` : "<p>None drawn.</p>"}
</section>
${flowLinks(model, id)}
${drawn ? `<section aria-labelledby="drawing-title"><h2 id="drawing-title">The drawing</h2><div class="map-host" data-chosen="${escapeHtml(id)}" data-enter>${map}</div></section>` : ""}`;
  return layout({ title: `Inside ${s.name}, in the Capsid explorer`, description: `The parts of ${s.name} and how they connect.`, path: containersPath(id), body, asOf, script: drawn });
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
function markStep(html, st) {
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
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Capsid explorer</a> / <span aria-current="page">${escapeHtml(f.name)}</span></nav>
<h1>${escapeHtml(f.name)}</h1>
<p class="lead">${escapeHtml(f.description ?? `${f.steps.length} steps.`)}</p>
<p><a href="${stepPath(f.id, 1)}">Start at step 1 of ${f.steps.length}</a></p>
<section aria-labelledby="steps-title"><h2 id="steps-title">Every step</h2>${stepList(f)}</section>`;
  return layout({ title: `${f.name}, in the Capsid explorer`, description: f.description ?? f.name, path: flowPath(f.id), body, asOf });
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
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Capsid explorer</a> / <a href="${flowPath(f.id)}">${escapeHtml(f.name)}</a> / <span aria-current="page">Step ${n}</span></nav>
<h1>${escapeHtml(f.name)}</h1>
<section class="flow-step" data-swap="step" aria-labelledby="step-title">
<div class="flow-stack">${f.steps.map((x) => stepText(x, total, systems, x.n === n)).join("")}</div>
<nav class="flow-nav" aria-label="Steps">${nav}</nav>
</section>
${drawn ? `<section aria-labelledby="drawing-title"><h2 id="drawing-title">The drawing</h2><p class="hint" data-keys hidden>Number keys 1 to ${Math.min(total, 9)} go to that step.</p><div class="map-host flow-map" data-flow="${escapeHtml(f.id)}" data-step="${n}" data-steps="${total}">${map}</div></section>` : ""}
<section aria-labelledby="steps-title"><h2 id="steps-title">Every step</h2>${stepList(f, n)}</section>`;
  return layout({
    title: `${f.name}, step ${n} of ${total}, in the Capsid explorer`,
    description: st.text,
    path: stepPath(f.id, n),
    body,
    asOf,
    script: drawn,
  });
}

/** @param {string} asOf */
export function notFoundPage(asOf) {
  return layout({
    title: "Not found, Capsid explorer",
    description: "No page here.",
    path: "/404",
    body: `<h1>Nothing here</h1><p class="lead">There is no page at this address. The <a href="/">explorer's front page</a> lists every system.</p>`,
    asOf,
  });
}

/**
 * Every page the explorer serves, as [path, html]: the front page, one per system, one per
 * public system with parts, one per flow and one per step of it, the code pages of each public
 * system with a code map, and the 404.
 * @param {any} model @param {any} stats @param {any} [code] the public code document
 * @param {(repo: string, path: string) => string | undefined} [sourceOf] a module's source at its map's commit
 * @returns {Array<[string, string]>}
 */
export function allPages(model, stats, code = null, sourceOf = () => undefined) {
  const asOf = stats.as_of;
  const bySystem = codeBySystem(model, code);
  /** @type {Array<[string, string]>} */
  const pages = [["/", homePage(model, stats)]];
  for (const s of model.systems) {
    pages.push([systemPath(s.id), systemPage(model, s.id, asOf, bySystem.get(s.id))]);
    if (!s.private && model.containers.some((/** @type {any} */ c) => c.system === s.id)) pages.push([containersPath(s.id), containersPage(model, s.id, asOf)]);
  }
  for (const f of flowsOf(model)) {
    pages.push([flowPath(f.id), flowPage(f, asOf)]);
    for (const st of f.steps) pages.push([stepPath(f.id, st.n), stepPage(model, f, st.n, asOf)]);
  }
  pages.push(...codePages(model, bySystem, sourceOf, asOf));
  pages.push(["/404", notFoundPage(asOf)]);
  return pages;
}
