// The numbers page: every public number Capsid computes (docs/public-data.md), each as a sentence,
// a picture and the table behind it, with the weekly trends where the document carries them.
// Enarratio draws the charts on the server; its enhance step (src/explorer.js) adds tooltips and
// keyboard reading. No chart takes a colour of its own, which would need a style attribute the
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
  const total = j.completed_by_week.reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0);
  // Under Enarratio's 480 the drawing scales to a phone's width instead of scrolling inside a
  // frame no keyboard can reach (axe, scrollable-region-focusable, on the phone project).
  const width = 440;
  const jobsChart = j.failed_by_week
    ? barChart({
        id: "jobs-per-week",
        data: weeks.flatMap((/** @type {string} */ week, /** @type {number} */ i) => [
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
        data: weeks.map((/** @type {string} */ week, /** @type {number} */ i) => ({ week, jobs: j.completed_by_week[i] })),
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
          title: "Claims agreeing with GitHub, per week",
          xLabel: "week ending",
          yLabel: "percent",
          points: true,
          width,
          formatValue: (/** @type {number} */ n) => `${n}%`,
          alt: `The share of checked claims that agreed with GitHub in each of the last eight whole weeks, oldest first: ${v.agreement_by_week.map((/** @type {number | null} */ x) => (x === null ? "too few to say" : percent(x))).join(", ")}.`,
        })
      : "";
  const rings = [];
  if (v.agreement_rate_90d !== null) rings.push(ring("agreement", "Claims agreeing", v.agreement_rate_90d, `In the last 90 days, ${percent(v.agreement_rate_90d)} of ${v.evaluations_90d} checked claims agreed with what GitHub records.`));
  if (v.pr_merge_rate_90d !== null) rings.push(ring("merged", "Pull requests merged", v.pr_merge_rate_90d, `${percent(v.pr_merge_rate_90d)} of the pull requests agents said they opened, as GitHub verified them, merged.`));
  if (v.ci_green_rate_90d !== null) rings.push(ring("green", "CI green", v.ci_green_rate_90d, `${percent(v.ci_green_rate_90d)} of the jobs whose CI the Worker verified were green on their head.`));
  const gateRings = [];
  if (g.share_ended_by_policy_30d !== null) gateRings.push(ring("policy", "Ended by policy", g.share_ended_by_policy_30d, `${percent(g.share_ended_by_policy_30d)} of the approval waits in the last 30 days were ended by the signed auto-merge policy, not a person.`));
  const siteRings = [];
  if (stats.sites.uptime_7d !== null) siteRings.push(ring("uptime", "Uptime, last 7 days", stats.sites.uptime_7d, `The ${stats.sites.watched} watched sites answered in ${percent(stats.sites.uptime_7d)} of ${stats.sites.slots_measured_7d} measured half-hours over the last seven days.`));
  const rows = [
    ["Jobs completed, last 7 days", j.completed_7d],
    ["Jobs completed, last 30 days", j.completed_30d],
    ["Jobs failed, last 30 days", j.failed_30d],
    ["Jobs open today", j.open],
    ["Jobs blocked today", j.blocked],
    ["Median time a job takes, last 30 days", minutes(j.median_duration_minutes_30d)],
    ["Claims checked, last 90 days", v.evaluations_90d],
    ["Claims agreeing with GitHub, last 90 days", percent(v.agreement_rate_90d)],
    ["Pull requests merged, of those claimed, last 90 days", percent(v.pr_merge_rate_90d)],
    ["CI green when claimed, last 90 days", percent(v.ci_green_rate_90d)],
    ["Approval waits, last 30 days", g.waits_30d],
    ["Median approval wait, last 30 days", minutes(g.median_wait_minutes_30d)],
    ["Waits ended by the signed policy, last 30 days", percent(g.share_ended_by_policy_30d)],
    ["Sites watched", stats.sites.watched],
    ["Half-hours measured, last 7 days", stats.sites.slots_measured_7d],
    ["Documents in the store", stats.store.documents],
    ["Namespaces", stats.store.namespaces],
    ...(stats.systems ? [["Systems, public and private", `${stats.systems.public} and ${stats.systems.private}`]] : []),
    ["Capsid's commit", stats.capsid.sha7],
  ];
  return `<section class="numbers" aria-labelledby="numbers-title">
<h2 id="numbers-title" class="cap-sr-only">The daily numbers</h2>
<dl class="readings readings-row">${reading(String(j.completed_30d), "jobs completed, 30 days", "#jobs")}${reading(percent(v.agreement_rate_90d), "claims agreeing with GitHub", "#verification")}${reading(minutes(g.median_wait_minutes_30d), "median approval wait", "#gates")}${reading(percent(stats.sites.uptime_7d), "uptime, 7 days", "#sites")}</dl>
<section class="numbers-part" id="jobs" aria-labelledby="jobs-title"><h3 id="jobs-title">Jobs</h3>
<p class="measure">${j.completed_30d} jobs completed and ${j.failed_30d} failed in the last 30 days. Today ${j.open} are open and ${j.blocked} of them blocked on a person. Half of last month's jobs took under ${minutes(j.median_duration_minutes_30d)} from first claim to done.</p>
<div class="charts">${jobsChart}</div></section>
<section class="numbers-part" id="verification" aria-labelledby="verification-title"><h3 id="verification-title">Claims, checked against GitHub</h3>
<p class="measure">When a job completes, the Worker reads its pull requests, commits and CI from GitHub and records each claim beside what GitHub says. Only fields the Worker verified count toward a rate.</p>
<div class="charts">${agreementChart}${rings.join("")}</div></section>
<section class="numbers-part" id="gates" aria-labelledby="gates-title"><h3 id="gates-title">Approval gates</h3>
<p class="measure">A push, a deploy, a secret or a merge stops the agent. The job waits with the exact command until a person, or the signed policy, answers. ${g.waits_30d} waits ended in the last 30 days; half within ${minutes(g.median_wait_minutes_30d)}.</p>
<div class="charts">${waitsChart}${gateRings.join("")}</div></section>
<section class="numbers-part" id="sites" aria-labelledby="sites-title"><h3 id="sites-title">Sites</h3>
<p class="measure">The watcher reads every registered site on Capsid's five-minute tick and keeps a ring of half-hour slots per site. A slot it could not measure is left out, never counted as up.</p>
<div class="charts">${siteRings.join("")}</div></section>
<section class="numbers-part" id="every" aria-labelledby="every-title"><h3 id="every-title">Every number</h3>
${scroller("numbers-table", `<table class="cap-table numbers-table"><caption class="cap-sr-only">Every number, as of ${escapeHtml(stats.as_of)}</caption><tbody>
${rows.map(([label, value]) => `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join("\n")}
</tbody></table>`, "Every number")}
</section>
<section class="numbers-part" id="how" aria-labelledby="how-title"><h3 id="how-title">How they are counted</h3>
<ul class="measure">
<li>Counts and rates across every namespace, agent and site at once: nothing here names a project, a job or a person.</li>
<li>Every window is whole UTC days ending at midnight, so a day's work appears the next day and no number says when anything happened.</li>
<li>A rate or median over fewer than ten cases is left out rather than shown, so no single job can be read off it.</li>
<li>The document is built once a day by the Worker and served at <a href="https://mcp.dustinedwards.info/public/stats/v1.json">/public/stats/v1.json</a>; <a href="https://github.com/DrDustinEdwards/capsid/blob/master/docs/public-data.md">docs/public-data.md</a> says what each field is read from.</li>
</ul></section>
</section>`;
}

/** @param {any} stats */
export function numbersPage(stats) {
  const body = `${pageHead([["/", "Overview"]], "Numbers", "The daily numbers", `Capsid's own record of its work, as of ${escapeHtml(stats.as_of)}: jobs, claims checked against GitHub, approval waits and uptime.`)}
${numbersHtml(stats)}`;
  return layout({ title: "Numbers, Capsid", description: "Capsid's daily numbers: jobs, verified claims, approval waits and uptime.", path: "/numbers/", body, asOf: stats.as_of });
}
