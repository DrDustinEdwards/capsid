// Enarratio draws each figure on the server. No chart takes a color of its own: that needs a style attribute the
// policy refuses. Pure.
import { frameHtml } from "capsomer/behavior/chart-frame";
import { progressRing } from "enarratio";

import { statusHtml } from "capsomer/behavior/status";
import { escapeHtml } from "@dustinedwards/site-runtime/html";
import { layout, pageHead, percent, scroller } from "./pages.mjs";

const source = {
  name: "Capsid's public stats",
  href: "https://mcp.dustinedwards.info/public/stats/v1.json",
};

const ring = (
  /** @type {string} */ id,
  /** @type {string} */ title,
  /** @type {number} */ rate,
  /** @type {string} */ sentence,
  /** @type {string} */ caption,
) =>
  frameHtml(
    progressRing({
      id,
      value: rate,
      max: 1,
      size: 112,
      title,
      label: title,
      alt: sentence,
      caption,
      source,
    }),
  );

/** @param {any} stats */
export function numbersHtml(stats) {
  const siteRings = [];
  if (stats.sites.uptime_7d === null)
    siteRings.push(
      `<p>${statusHtml("nodata", "No data", { reason: "fewer than ten half-hours were measured in the last 7 days" })}</p>`,
    );
  else
    siteRings.push(
      ring(
        "uptime",
        "Uptime, last 7 days",
        stats.sites.uptime_7d,
        `The ${stats.sites.watched} watched sites were up in ${percent(stats.sites.uptime_7d)} of ${stats.sites.slots_measured_7d} measured half-hours over the last 7 days.`,
        "Measured half-hours only; a slot the watcher could not measure is left out.",
      ),
    );
  const rows = [
    ["Sites watched", stats.sites.watched],
    ["Half-hours measured, last 7 days", stats.sites.slots_measured_7d],
    ["Documents in the store", stats.store.documents],
    ["Namespaces", stats.store.namespaces],
    ...(stats.systems
      ? [["Systems, public and private", `${stats.systems.public} and ${stats.systems.private}`]]
      : []),
    ["Capsid's commit", stats.capsid.sha7],
  ];
  return `<section class="numbers">
<section class="numbers-part" id="sites" aria-labelledby="sites-title"><h2 id="sites-title">Sites</h2>
<p class="measure">Every five minutes, the watcher checks each registered site and keeps a ring of half-hour slots for it. When it can't measure a slot, it leaves the slot out instead of counting it as up.</p>
<div class="charts">${siteRings.join("")}</div></section>
<section class="numbers-part" id="every" aria-labelledby="every-title"><h2 id="every-title">Every number</h2>
${scroller(
  "numbers-table",
  `<table class="cap-table numbers-table"><caption class="cap-sr-only">Every number, as of ${escapeHtml(stats.as_of)}</caption><tbody>
${rows.map(([label, value]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join("\n")}
</tbody></table>`,
  "Every number table",
)}
</section>
<section class="numbers-part" id="how" aria-labelledby="how-title"><h2 id="how-title">How Capsid counts</h2>
<ul class="measure">
<li>Every count and rate covers all namespaces, agents and sites together, so nothing here names a project or a person.</li>
<li>Each window counts whole UTC days to midnight, so a day's work shows up the next day and no number says when anything happened.</li>
<li>The page leaves out any rate or median based on fewer than ten cases, so nobody can work out a single case from it.</li>
<li>The Worker builds the data once a day and serves it at <a href="https://mcp.dustinedwards.info/public/stats/v1.json">/public/stats/v1.json</a>. <a href="https://github.com/DrDustinEdwards/capsid/blob/master/docs/public-data.md">docs/public-data.md</a> says where each field comes from.</li>
</ul></section>
</section>`;
}

/** @param {any} stats */
export function numbersPage(stats) {
  const body = `${pageHead([], "Numbers", "The daily numbers", `As of ${escapeHtml(stats.as_of)}.`)}
${numbersHtml(stats)}`;
  return layout({
    title: "Numbers",
    description: "Capsid's daily numbers: uptime and the store.",
    path: "/numbers/",
    body,
    asOf: stats.as_of,
  });
}
