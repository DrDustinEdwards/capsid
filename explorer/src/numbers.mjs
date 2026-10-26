// The numbers page: every public number Capsid computes (docs/public-data.md), each as a sentence,
// a picture and the table behind it, with the weekly trends where the document carries them.
// Enarratio draws the charts on the server; its enhance step (src/explorer.js) adds tooltips and
// keyboard reading. No chart takes a color of its own, which would need a style attribute the
// policy refuses. Pure.
import { progressRing } from "enarratio";
import { areaChart, barChart, lineChart } from "enarratio/lite";

import { weekLabels } from "./home.mjs";
import { escapeHtml, layout, minutes, pageHead, percent, reading, scroller } from "./pages.mjs";

/** A ring, its heading and its sentence: Enarratio's ring is a primitive, so the figure is ours. */
const ring = (/** @type {string} */ id, /** @type {string} */ title, /** @type {number} */ rate, /** @type {string} */ sentence) =>
  `<figure class="ring" aria-labelledby="${id}-title"><h3 id="${id}-title">${escapeHtml(title)}</h3>${progressRing({ value: rate, max: 1, size: 112, alt: sentence })}<figcaption>${escapeHtml(sentence)}</figcaption></figure>`;

/**
 * The daily numbers: each a sentence, a picture and the table behind it (design section 4).
 * Used whole on the numbers page.
 * @param {any} stats
 */
export function numbersHtml(stats) {
  const j = stats.jobs;
  const v = stats.verification;
  const g = stats.gates;
  const weeks = weekLabels(stats);
  // The bars name each week by its day, with its month at the first, the newest and wherever the
  // month changes, so eight labels fit under eight bars.
  const days = weeks.map((/** @type {string} */ w, /** @type {number} */ i) => (i && i < weeks.length - 1 && w.split(" ")[1] === weeks[i - 1].split(" ")[1] ? w.split(" ")[0] : w));
  const total = j.completed_by_week.reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0);
  // Under Enarratio's 480 the drawing scales to a phone's width instead of scrolling inside a
  // frame no keyboard can reach (axe, scrollable-region-focusable, on the phone project).
  const width = 440;
  const jobsChart = j.failed_by_week
    ? barChart({
        id: "jobs-per-week",
        data: days.flatMap((/** @type {string} */ week, /** @type {number} */ i) => [
          { week, outcome: "Completed", jobs: j.completed_by_week[i] },
          { week, outcome: "Failed", jobs: j.failed_by_week[i] },
        ]),
        x: "week",
        y: "jobs",
        series: "outcome",
        layout: "stacked",
        title: "Jobs finished per week",
        xLabel: "week ending",
        width,
        alt: `Jobs finished in each of the last eight whole weeks, oldest first. Completed: ${j.completed_by_week.join(", ")}. Failed: ${j.failed_by_week.join(", ")}.`,
      })
    : barChart({
        id: "jobs-per-week",
        data: days.map((/** @type {string} */ week, /** @type {number} */ i) => ({ week, jobs: j.completed_by_week[i] })),
        x: "week",
        y: "jobs",
        title: "Jobs completed per week",
        xLabel: "week ending",
        width,
        alt: `Jobs completed in each of the last eight whole weeks, oldest first: ${j.completed_by_week.join(", ")}; ${total} in all.`,
      });
  const waitsChart = g.waits_by_week
    ? areaChart({
        id: "waits-per-week",
        data: weeks.map((/** @type {string} */ week, /** @type {number} */ i) => ({ week, waits: g.waits_by_week[i] })),
        x: "week",
        y: "waits",
        title: "Approval waits per week",
        xLabel: "week ending",
        width,
        alt: `Approval waits that ended in each of the last eight whole weeks, oldest first: ${g.waits_by_week.join(", ")}.`,
      })
    : "";
  const measuredWeeks = (v.agreement_by_week ?? []).filter((/** @type {number | null} */ x) => x !== null).length;
  const agreementChart =
    measuredWeeks >= 2
      ? lineChart({
          id: "agreement-per-week",
          data: weeks.map((/** @type {string} */ week, /** @type {number} */ i) => ({ week, agreement: v.agreement_by_week[i] === null ? null : Math.round(v.agreement_by_week[i] * 1000) / 10 })),
          x: "week",
          y: "agreement",
          title: "Claims matching GitHub, per week",
          xLabel: "week ending",
          yLabel: "percent",
          points: true,
          width,
          formatValue: (/** @type {number} */ n) => `${n}%`,
          alt: `The share of checked claims that agreed with GitHub in each of the last eight whole weeks, oldest first: ${v.agreement_by_week.map((/** @type {number | null} */ x) => (x === null ? "too few to say" : percent(x))).join(", ")}.`,
        })
      : "";
  const rings = [];
  if (v.agreement_rate_90d !== null) rings.push(ring("agreement", "Claims matching", v.agreement_rate_90d, `In the last 90 days, ${percent(v.agreement_rate_90d)} of ${v.evaluations_90d.toLocaleString("en-US")} checked claims matched what GitHub shows.`));
  if (v.pr_merge_rate_90d !== null) rings.push(ring("merged", "Pull requests merged", v.pr_merge_rate_90d, `GitHub shows that ${percent(v.pr_merge_rate_90d)} of the pull requests agents opened were merged.`));
  if (v.ci_green_rate_90d !== null) rings.push(ring("green", "CI passing", v.ci_green_rate_90d, `${percent(v.ci_green_rate_90d)} of the jobs whose CI the Worker checked had passing CI on their latest commit.`));
  const gateRings = [];
  if (g.share_ended_by_policy_30d !== null) gateRings.push(ring("policy", "Ended by policy", g.share_ended_by_policy_30d, `The signed auto-merge policy, not a person, ended ${percent(g.share_ended_by_policy_30d)} of the approval waits in the last 30 days.`));
  const siteRings = [];
  if (stats.sites.uptime_7d !== null) siteRings.push(ring("uptime", "Uptime, last 7 days", stats.sites.uptime_7d, `The ${stats.sites.watched} watched sites were up in ${percent(stats.sites.uptime_7d)} of ${stats.sites.slots_measured_7d} measured half-hours over the last 7 days.`));
  const rows = [
    ["Jobs completed, last 7 days", j.completed_7d],
    ["Jobs completed, last 30 days", j.completed_30d],
    ["Jobs failed, last 30 days", j.failed_30d],
    ["Jobs open today", j.open],
    ["Jobs waiting on a person today", j.blocked],
    ["Median time a job takes, last 30 days", minutes(j.median_duration_minutes_30d)],
    ["Claims checked, last 90 days", v.evaluations_90d],
    ["Claims matching GitHub, last 90 days", percent(v.agreement_rate_90d)],
    ["Agents' pull requests merged, last 90 days", percent(v.pr_merge_rate_90d)],
    ["Checked jobs with passing CI, last 90 days", percent(v.ci_green_rate_90d)],
    ["Approval waits, last 30 days", g.waits_30d],
    ["Median approval wait, last 30 days", minutes(g.median_wait_minutes_30d)],
    ["Waits the signed policy cleared, last 30 days", percent(g.share_ended_by_policy_30d)],
    ["Sites watched", stats.sites.watched],
    ["Half-hours measured, last 7 days", stats.sites.slots_measured_7d],
    ["Documents in the store", stats.store.documents],
    ["Namespaces", stats.store.namespaces],
    ...(stats.systems ? [["Systems, public and private", `${stats.systems.public} and ${stats.systems.private}`]] : []),
    ["Capsid's commit", stats.capsid.sha7],
  ];
  return `<section class="numbers">
<dl class="readings readings-row">${reading(String(j.completed_30d), "jobs completed, 30 days", "#jobs")}${reading(percent(v.agreement_rate_90d), "claims matching GitHub", "#verification")}${reading(minutes(g.median_wait_minutes_30d), "median approval wait", "#gates")}${reading(percent(stats.sites.uptime_7d), "uptime, 7 days", "#sites")}</dl>
<section class="numbers-part" id="jobs" aria-labelledby="jobs-title"><h2 id="jobs-title">Jobs</h2>
<p class="measure">In the last 30 days, ${j.completed_30d} jobs finished and ${j.failed_30d} failed. ${j.open} are open today, and ${j.blocked} of those are waiting on a person. The median job took ${minutes(j.median_duration_minutes_30d)} from first claim to done.</p>
<div class="charts">${jobsChart}</div></section>
<section class="numbers-part" id="verification" aria-labelledby="verification-title"><h2 id="verification-title">Claims checked against GitHub</h2>
<p class="measure">When a job finishes, the Worker reads its pull requests, commits and CI from GitHub and saves each claim next to what GitHub says. A rate counts only the fields the Worker checked.</p>
<div class="charts">${agreementChart}${rings.join("")}</div></section>
<section class="numbers-part" id="gates" aria-labelledby="gates-title"><h2 id="gates-title">Approval gates</h2>
<p class="measure">Before a push, a deploy, a secret or a merge, the agent stops. The job waits with the exact command until a person or the signed policy answers. ${g.waits_30d} waits ended in the last 30 days, and half ended within ${minutes(g.median_wait_minutes_30d)}.</p>
<div class="charts">${waitsChart}${gateRings.join("")}</div></section>
<section class="numbers-part" id="sites" aria-labelledby="sites-title"><h2 id="sites-title">Sites</h2>
<p class="measure">Every five minutes, the watcher checks each registered site and keeps a ring of half-hour slots for it. When it can't measure a slot, it leaves the slot out instead of counting it as up.</p>
<div class="charts">${siteRings.join("")}</div></section>
<section class="numbers-part" id="every" aria-labelledby="every-title"><h2 id="every-title">Every number</h2>
${scroller("numbers-table", `<table class="cap-table numbers-table"><caption class="cap-sr-only">Every number, as of ${escapeHtml(stats.as_of)}</caption><tbody>
${rows.map(([label, value]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join("\n")}
</tbody></table>`, "Every number")}
</section>
<section class="numbers-part" id="how" aria-labelledby="how-title"><h2 id="how-title">How Capsid counts</h2>
<ul class="measure">
<li>Every count and rate covers all namespaces, agents and sites together, so nothing here names a project, a job or a person.</li>
<li>Each window counts whole UTC days to midnight, so a day's work shows up the next day and no number says when anything happened.</li>
<li>The page leaves out any rate or median based on fewer than ten cases, so nobody can work out a single job from it.</li>
<li>The Worker builds the data once a day and serves it at <a href="https://mcp.dustinedwards.info/public/stats/v1.json">/public/stats/v1.json</a>. <a href="https://github.com/DrDustinEdwards/capsid/blob/master/docs/public-data.md">docs/public-data.md</a> says where each field comes from.</li>
</ul></section>
</section>`;
}

/** @param {any} stats */
export function numbersPage(stats) {
  const body = `${pageHead([["/", "Overview"]], "Numbers", "The daily numbers", `What this Capsid server recorded up to ${escapeHtml(stats.as_of)}: jobs, claims checked against GitHub, approval waits and uptime.`)}
${numbersHtml(stats)}`;
  return layout({ title: "Numbers, Capsid", description: "Capsid's daily numbers: jobs, verified claims, approval waits and uptime.", path: "/numbers/", body, asOf: stats.as_of });
}
