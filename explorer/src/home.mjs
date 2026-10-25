// The front page. First the panel: every tool Capsid serves as a circuit, lit by the grants a
// caller holds, which the reader switches. Then one job's life as a guided tour, the drawing of
// Capsid's insides pinned beside the chapters; then three of the day's figures, and everything it
// holds as a poster. Pure, as pages.mjs is.
//
// Every number is from the public numbers or the model; every sentence that states a fact about
// how Capsid works is the model's own flow text.

import { escapeHtml, flowStage, flowsOf, layout, manualHead, minutes, percent, reading, stepPath, stepWords, systemPath } from "./pages.mjs";
import { toolPath } from "./tools.mjs";

/** The week each bar of a weekly series ends on, labelled as the numbers page does. @param {any} stats */
export function weekLabels(stats) {
  const end = new Date(Date.parse(`${stats.as_of}T00:00:00Z`) - 86_400_000);
  return stats.jobs.completed_by_week.map((/** @type {number} */ _c, /** @type {number} */ i, /** @type {number[]} */ all) =>
    new Date(end.getTime() - (all.length - 1 - i) * 7 * 86_400_000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).replace("Sept", "Sep")
  );
}

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

/** What each grant requirement asks of a caller, in words (src/scope.ts, needFor). */
const NEED = {
  read: "the read grant",
  write: "the write grant",
  action: "the read grant for some actions and the write grant for the rest",
  admin: "the admin identity and the write grant",
  admin_read: "the admin identity and the read grant",
};

/** The grants a caller can hold, as the panel's breakers. */
const BREAKERS = [
  ["read", "Read grant", "Reads documents, repos and the queue"],
  ["write", "Write grant", "Writes documents, branches and pull requests"],
  ["admin", "Admin identity", "Mints agents and holds the switches"],
];

/**
 * Whether a caller holding these grants reaches a tool: "full", "part" (an action tool, some of
 * whose actions need the grant it lacks) or "" (src/scope.ts: needFor, checkScope). The script
 * runs the same rule as the breakers move (src/explorer.js, board).
 * @param {string} need @param {{ read: boolean, write: boolean, admin: boolean }} held
 */
export function reaches(need, held) {
  if (need === "read") return held.read ? "full" : "";
  if (need === "write") return held.write ? "full" : "";
  if (need === "admin") return held.admin && held.write ? "full" : "";
  if (need === "admin_read") return held.admin && held.read ? "full" : "";
  if (need === "action") return held.read && held.write ? "full" : held.read || held.write ? "part" : "";
  return "";
}

/** How many tools a caller with these grants reaches, in words. @param {any[]} tools @param {{ read: boolean, write: boolean, admin: boolean }} held */
export function reachSentence(tools, held) {
  const full = tools.filter((t) => reaches(t.grant, held) === "full").length;
  const part = tools.filter((t) => reaches(t.grant, held) === "part").length;
  return `${full} of ${tools.length} tools live${part ? `, ${part} in part` : ""}.`;
}

/**
 * The first screen: what Capsid is, the two ways on, and its panel: every tool it serves as a
 * circuit, each lit when the grants switched on reach it. It opens as a read-only agent sees it.
 * @param {any[]} tools
 */
function board(tools) {
  const held = { read: true, write: false, admin: false };
  const circuits = tools
    .map((t) => {
      const on = reaches(t.grant, held);
      return `<li class="circuit" data-need="${escapeHtml(t.grant)}"${on ? ` data-on="${on}"` : ""}><a href="${toolPath(t.name)}"><span class="lamp" aria-hidden="true"></span><span class="circuit-name">${escapeHtml(t.title)}</span><code>${escapeHtml(t.name)}</code></a><span class="cap-sr-only">: needs ${NEED[/** @type {keyof typeof NEED} */ (t.grant)] ?? escapeHtml(t.grant)}</span></li>`;
    })
    .join("");
  return `<section class="board" aria-labelledby="board-title">
<div class="board-words">
${manualHead("/")}
<h1 id="board-title">One panel, every agent</h1>
<p class="lead">Capsid is an MCP server on one Cloudflare Worker. Agents claim signed jobs, act only through the grants they hold, and a job counts as done only when GitHub agrees.</p>
<p class="board-actions"><a class="cap-btn" data-variant="primary" href="https://github.com/DrDustinEdwards/capsid#installation">Run your own</a><a class="board-link" href="#tour">Follow one job</a></p>
<p class="board-note">This is a live instance. Every tool, step and number here is its own, rebuilt each day.</p>
</div>
<div class="board-panel" data-ui data-board data-read>
<h2 class="cap-sr-only">The panel</h2>
<div class="breakers" role="group" aria-label="What the agent holds">${BREAKERS.map(([grant, name, does]) => `<button type="button" class="breaker" data-grant="${grant}" aria-pressed="${grant === "read"}"><span class="breaker-slot" aria-hidden="true"><span class="breaker-handle"></span></span><span class="breaker-name">${name}</span><span class="breaker-does">${does}</span></button>`).join("")}</div>
<p class="board-count" role="status" data-board-count>A read-only agent: ${reachSentence(tools, held)}</p>
<ol class="circuits">${circuits}</ol>
</div>
</section>`;
}

/** The tour: a chapter a step, the drawing pinned beside them. */
function tour(/** @type {any} */ model, /** @type {any} */ stats) {
  const core = model.systems.find((/** @type {any} */ s) => s.ring === "core");
  const flows = flowsOf(model).filter((f) => core && f.steps.every((x) => x.touches.every((p) => p.system === core.id)));
  const life = flows.find((f) => f.id === "job-life") ?? flows[0];
  if (!life) return "";
  const readings = readingsByStep(stats);
  const chapters = life.steps
    .map((st) => {
      const { name, text } = stepWords(st);
      const kept = readings[name.toLowerCase()] ?? [];
      return `<li class="chapter" data-tour-step="${st.n}">
<h3>${escapeHtml(name)} <span class="chapter-n">${st.n} of ${life.steps.length}</span></h3>
<p>${escapeHtml(text)}</p>
<p class="chapter-parts">${st.touches.map((p) => `<span class="part-name" data-part="${escapeHtml(p.id)}">${escapeHtml(p.name)}</span>`).join("")}</p>
${kept.length ? `<dl class="readings readings-small">${kept.map(([value, label]) => reading(value, label)).join("")}</dl>` : ""}
<p class="chapter-link"><a href="${stepPath(life.id, st.n)}">This step on its own</a></p>
</li>`;
    })
    .join("");
  return `<section class="tour" id="tour" aria-labelledby="tour-title">
<div class="tour-grid wrap">
<div class="tour-words">
<h2 class="tour-title" id="tour-title">Follow one job through it</h2>
<p class="lead">${escapeHtml(life.description ?? "")} Scroll, and the job moves through Capsid's real parts.</p>
<ol class="tour-steps">${chapters}</ol>
</div>
<div class="tour-stage tour-map" data-ui>${flowStage(model, flows, life, "tour-map", false)}</div>
</div>
</section>`;
}

/** Its own record: three of the day's figures on tiles that refuse to line up. @param {any} stats */
function record(stats) {
  const { jobs: j, verification: v, gates: g } = stats;
  return `<section class="record wrap" aria-labelledby="record-title">
<h2 id="record-title">Its own record</h2>
<a class="tile tile-tall" href="/numbers/#verification"><span class="tile-figure">${escapeHtml(percent(v.agreement_rate_90d))}</span><span class="tile-caption">of ${v.evaluations_90d.toLocaleString("en-GB")} claims agreed with what GitHub records, last 90 days</span></a>
<a class="tile tile-ink" href="/numbers/#jobs"><span class="tile-figure">${escapeHtml(String(j.completed_30d))}</span><span class="tile-caption">jobs completed, last 30 days</span></a>
<a class="tile tile-mid" href="/numbers/#gates"><span class="tile-figure">${escapeHtml(minutes(g.median_wait_minutes_30d))}</span><span class="tile-caption">median wait for a person or the signed policy</span></a>
</section>`;
}

/** What one Worker holds, set as a poster, each line leading on; then every system by name. */
function holds(/** @type {any} */ model, /** @type {any} */ stats, /** @type {any[]} */ tools, /** @type {any} */ codeIndex) {
  const rows = [
    ["/tools/", "Tools", `${tools.length} served over MCP`],
    ["/flows/", "Flows", `${flowsOf(model).length} told step by step`],
    ["/systems/", "Systems", `${model.systems.length} drawn with their parts`],
    ["/numbers/", "Numbers", `${stats.store.documents.toLocaleString("en-GB")} documents held`],
    ...(codeIndex ? [["/code/", "Code", `${codeIndex.modules.toLocaleString("en-GB")} modules scored`]] : []),
  ];
  return `<section class="holds" aria-labelledby="holds-title">
<h2 id="holds-title" class="cap-sr-only">Everything it holds</h2>
<ul class="poster">${rows.map(([href, name, fact]) => `<li><a href="${href}"><span class="poster-name">${name}</span><span class="poster-fact">${escapeHtml(fact)}</span></a></li>`).join("")}</ul>
<div class="wrap">
<h3>Every system</h3>
<ul class="system-names">${model.systems.map((/** @type {any} */ s) => `<li><a href="${systemPath(s.id)}">${escapeHtml(s.name)}</a></li>`).join("")}</ul>
</div>
</section>`;
}

/**
 * @param {any} model @param {any} stats @param {any[]} tools the served tools (src/surface.mjs)
 * @param {any} codeIndex totals over the code maps (code.mjs, codeTotals), or null
 */
export function homePage(model, stats, tools, codeIndex) {
  const body = [board(tools), tour(model, stats), record(stats), holds(model, stats, tools, codeIndex)].join("\n");
  return layout({
    title: "Capsid: one panel for every AI agent",
    description: "Capsid is an MCP server on one Cloudflare Worker: a signed work queue, scoped grants checked at one point, and every agent's claim checked against GitHub.",
    path: "/",
    body,
    asOf: stats.as_of,
    wide: true,
  });
}
