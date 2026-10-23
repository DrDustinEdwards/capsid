// The front page: one job's life through Capsid, told as a guided tour. The drawing of Capsid's
// insides stays pinned beside the words and steps as each chapter reaches the middle of the
// screen; each chapter names the parts it lights, in the drawing's own colour, and carries the
// reading Capsid keeps for that moment. Then one index of where to go deeper. Pure, as pages.mjs is.
//
// Every number is from the public numbers or the model; every sentence that states a fact about
// how Capsid works is the model's own flow text.

import { escapeHtml, flowStage, flowsOf, layout, minutes, percent, stepPath, systemPath } from "./pages.mjs";

/** The week each bar of a weekly series ends on, labelled as the numbers page does. @param {any} stats */
export function weekLabels(stats) {
  const end = new Date(Date.parse(`${stats.as_of}T00:00:00Z`) - 86_400_000);
  return stats.jobs.completed_by_week.map((/** @type {number} */ _c, /** @type {number} */ i, /** @type {number[]} */ all) =>
    new Date(end.getTime() - (all.length - 1 - i) * 7 * 86_400_000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).replace("Sept", "Sep")
  );
}

/** One instrument reading: a figure and what it counts. @param {string} value @param {string} label */
const reading = (value, label) => `<div class="reading"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;

/**
 * The reading Capsid keeps for each moment of a job's life, by the step's own name (the words
 * before its colon in the model). A step with no reading of its own carries none.
 * @param {any} stats @returns {Record<string, [string, string][]>}
 */
function readingsByStep(stats) {
  const { jobs: j, verification: v, gates: g } = stats;
  return {
    posted: [[String(j.completed_30d), "jobs completed, last 30 days"]],
    claimed: [[String(j.open), "open today"], [String(j.blocked), "blocked on a person"]],
    worked: [[minutes(j.median_duration_minutes_30d), "half of last month's jobs took under"]],
    blocked: [[String(g.waits_30d), "approval waits, last 30 days"], [minutes(g.median_wait_minutes_30d), "median wait"]],
    "pull request": [[percent(v.pr_merge_rate_90d), "of claimed pull requests merged"]],
    merged: [[percent(g.share_ended_by_policy_30d), "of waits ended by the signed policy"]],
    deployed: [[percent(v.ci_green_rate_90d), "of claimed CI green on its head"]],
    verified: [[stats.capsid.sha7, "the commit live right now"]],
    "claims checked": [[percent(v.agreement_rate_90d), `of ${v.evaluations_90d} claims agreed with GitHub, 90 days`]],
  };
}

/** The opening: what the page is, in a line, and the readings that matter most. */
function opening(/** @type {any} */ model, /** @type {any} */ stats, /** @type {any[]} */ tools) {
  return `<div class="opening">
<h1 id="opening-title">Follow one job through Capsid</h1>
<p class="lead">Capsid is the one Worker every project and every AI session runs through. It holds what they know, queues what they do, and checks what each agent claims against GitHub before a job counts as done. Scroll, and one job moves through its real parts.</p>
<dl class="readings">${reading(String(model.systems.length), "systems")}${reading(String(tools.length), "MCP tools")}${reading(stats.store.documents.toLocaleString("en-GB"), "documents")}${reading(percent(stats.sites.uptime_7d), "uptime, 7 days")}</dl>
</div>`;
}

/** The tour: the opening, then a chapter a step, the drawing pinned beside them. */
function tour(/** @type {any} */ model, /** @type {any} */ stats, /** @type {any[]} */ tools) {
  const core = model.systems.find((/** @type {any} */ s) => s.ring === "core");
  const flows = flowsOf(model).filter((f) => core && f.steps.every((x) => x.touches.every((p) => p.system === core.id)));
  const life = flows.find((f) => f.id === "job-life") ?? flows[0];
  if (!life) return `<section class="tour wrap" aria-labelledby="opening-title">${opening(model, stats, tools)}</section>`;
  const readings = readingsByStep(stats);
  const chapters = life.steps
    .map((st) => {
      const [head, ...rest] = st.text.split(": ");
      const name = rest.length ? head : `Step ${st.n}`;
      const said = rest.length ? rest.join(": ") : st.text;
      const text = said.charAt(0).toUpperCase() + said.slice(1);
      const kept = readings[name.toLowerCase()] ?? [];
      return `<li class="chapter" data-tour-step="${st.n}">
<p class="chapter-n">${st.n} of ${life.steps.length}</p>
<h3>${escapeHtml(name)}</h3>
<p>${escapeHtml(text)}</p>
<p class="chapter-parts">${st.touches.map((p) => `<span class="part-name" data-part="${escapeHtml(p.id)}">${escapeHtml(p.name)}</span>`).join("")}</p>
${kept.length ? `<dl class="readings readings-small">${kept.map(([value, label]) => reading(value, label)).join("")}</dl>` : ""}
<p class="chapter-link"><a href="${stepPath(life.id, st.n)}">This step on its own</a></p>
</li>`;
    })
    .join("");
  return `<section class="tour" aria-labelledby="opening-title">
<div class="tour-grid wrap">
<div class="tour-words">
${opening(model, stats, tools)}
<h2 class="tour-title">${escapeHtml(life.name)}, in ${life.steps.length} steps</h2>
<ol class="tour-steps">${chapters}</ol>
</div>
<div class="tour-stage tour-map" data-ui>${flowStage(model, flows, life, "tour-map", false)}</div>
</div>
</section>`;
}

/** Where to go deeper: each section with its live reading, then every system by name. */
function deeper(/** @type {any} */ model, /** @type {any} */ stats, /** @type {any[]} */ tools, /** @type {any} */ codeIndex) {
  const flows = flowsOf(model);
  const privates = model.systems.filter((/** @type {any} */ s) => s.private).length;
  const rows = [
    ["/systems/", "Systems", `${model.systems.length}`, "systems", `The family drawn as a capsid: Capsid in the middle, the shared parts around it, what people use outside${privates ? `, ${privates} of them private` : ""}.`],
    ["/flows/", "Flows", `${flows.length}`, "flows", `What runs, step by step: ${flows.map((f) => escapeHtml(f.name)).join(", ")}.`],
    ["/tools/", "Tools", `${tools.length}`, "tools", "Every MCP tool it serves, with the grant it needs, what it may change and every argument."],
    ["/numbers/", "Numbers", String(stats.jobs.completed_30d), "jobs, 30 days", "The daily record: jobs, claims checked against GitHub, approval waits and uptime, with weekly trends."],
    ["/code/", "Code", codeIndex ? codeIndex.modules.toLocaleString("en-GB") : "", codeIndex ? "modules" : "", "Each public repo's modules and functions, scored for risk and for how well their tests catch bugs."],
  ];
  return `<section class="deeper wrap" aria-labelledby="deeper-title">
<h2 id="deeper-title">Go deeper</h2>
<ul class="deeper-list">${rows
    .map(([href, name, figure, unit, text]) => `<li><a href="${href}"><span class="deeper-figure">${escapeHtml(figure)}<small>${escapeHtml(unit)}</small></span><span class="deeper-name">${name}</span><span class="deeper-text">${text}</span></a></li>`)
    .join("")}</ul>
<h3>Every system</h3>
<ul class="system-names">${model.systems.map((/** @type {any} */ s) => `<li><a href="${systemPath(s.id)}">${escapeHtml(s.name)}</a></li>`).join("")}</ul>
</section>`;
}

/**
 * @param {any} model @param {any} stats @param {any[]} tools the served tools (src/surface.mjs)
 * @param {any} codeIndex totals over the code maps (code.mjs, codeTotals), or null
 */
export function homePage(model, stats, tools, codeIndex) {
  const body = [tour(model, stats, tools), deeper(model, stats, tools, codeIndex)].join("\n");
  return layout({
    title: "Capsid, inside and out",
    description: `Follow one job through Capsid, the Worker behind ${model.systems.length} systems and the AI sessions that work on them.`,
    path: "/",
    body,
    asOf: stats.as_of,
    wide: true,
  });
}
